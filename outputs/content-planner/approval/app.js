(() => {
  'use strict';

  const platforms = [
    ['instagram', 'Instagram'],
    ['facebookPage', 'Facebook-side'],
  ];
  const embedded = JSON.parse(document.querySelector('#drafts-data')?.textContent || '[]');
  const storageKey = 'soma-content-planner-review-v1';
  const session = window.__SOMA_SESSION__
    || JSON.parse(document.querySelector('#soma-session')?.textContent || 'null');
  const canApprove = Boolean(session?.key);
  const apiBase = session?.endpoint ? session.endpoint.replace(/approve$/, '') : new URL('.', location.href).href;
  const sendMessages = new Map();
  let busy = false;
  const OUTCOME_MESSAGES = {
    stale_revision: 'Opslaget er ændret, siden siden blev åbnet. Genindlæs siden og kontrollér igen.',
    terminal: 'Opslaget kan ikke godkendes, fordi det er afsluttet.',
    warnings_not_acknowledged: 'Advarsler skal bekræftes, før opslaget kan godkendes.',
    unknown_draft: 'Opslaget findes ikke længere. Genindlæs siden.',
    unknown_asset: 'Billedet er ikke længere godkendt til opslag. Genindlæs siden.',
    unchanged: 'Der er ingen ændring at gemme.',
    unknown_option: 'Gusmesteren kan ikke vælges for dette opslag. Genindlæs siden.',
    duplicate_asset: 'Det andet opslag om samme event bruger allerede det billede. Vælg et andet.',
    render_rejected: 'Billedet kunne ikke bruges: teksten passer ikke på det. Vælg et andet.',
    render_failed: 'Billedet kunne ikke genereres. Prøv igen.',
    render_unavailable: 'Billedgenerering er ikke installeret på denne computer (kør npm ci i runtime-mappen).',
  };
  const pickers = new Map();

  function restoreSavedDrafts(current) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (!Array.isArray(saved)) return current;
      const savedById = new Map(saved.map((draft) => [draft.draftId, draft]));
      return current.map((draft) => {
        if (draft.status === 'obsolete') return draft;
        const match = savedById.get(draft.draftId);
        if (!match
          || match.revision !== draft.revision
          || match.eventFingerprint !== draft.eventFingerprint
          || match.contentFingerprint !== draft.contentFingerprint) return draft;
        if (!match.localEdit) return draft;
        return {
          ...draft,
          localEdit: true,
          status: match.status,
          platformCopies: structuredClone(match.platformCopies),
          approvedAt: match.approvedAt || null,
          warningsAcknowledged: Boolean(match.warningsAcknowledged),
          manualInstructor: match.manualInstructor || null,
          event: structuredClone(match.event || draft.event),
          warnings: structuredClone(match.warnings || []),
          render: structuredClone(match.render || draft.render),
          renderPath: match.renderPath || draft.renderPath,
          history: structuredClone(match.history || []),
        };
      });
    } catch {
      return current;
    }
  }

  const drafts = restoreSavedDrafts(structuredClone(window.__SOMA_DRAFTS__ || embedded));
  const active = new Map(drafts.map((draft) => [draft.draftId, 'instagram']));
  const root = document.querySelector('#drafts');

  function persistDrafts() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(drafts));
    } catch {
      // Eksportknappen er fortsat den manuelle sikkerhedskopi, hvis browserlager er utilgængeligt.
    }
  }

  function dateLabel(event) {
    if (!event) return '';
    return `${event.date} · ${event.start}–${event.end}`;
  }

  function setStatus(draft, status, type) {
    const from = draft.status;
    draft.status = status;
    draft.history = [...(draft.history || []), { at: new Date().toISOString(), type, from, to: status }];
    if (status === 'approved') draft.approvedAt = new Date().toISOString();
    else draft.approvedAt = null;
    persistDrafts();
  }

  async function sendApprovals(items) {
    try {
      const response = await fetch(session.endpoint || new URL('approve', location.href).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-soma-key': session.key },
        body: JSON.stringify({ items }),
      });
      if (!response.ok) return { results: [], pushed: false, error: `http_${response.status}` };
      return await response.json();
    } catch {
      return { results: [], pushed: false, error: 'network' };
    }
  }

  async function approveDrafts(selected) {
    if (!canApprove || !selected.length || busy) return;
    busy = true;
    render();
    const response = await sendApprovals(selected.map((draft) => ({
      draftId: draft.draftId, contentRevision: draft.contentRevision,
    })));
    busy = false;
    for (const draft of selected) {
      const outcome = (response.results || []).find((item) => item.draftId === draft.draftId)?.outcome || 'not_processed';
      if (outcome === 'already_approved' || (outcome === 'approved' && response.pushed)) {
        sendMessages.delete(draft.draftId);
        setStatus(draft, 'approved', 'approve');
      } else {
        sendMessages.set(draft.draftId, OUTCOME_MESSAGES[outcome]
          || `Ikke sendt til GitHub (${response.error || 'ukendt fejl'}). Prøv igen.`);
      }
    }
    render();
  }

  // Serverens nye version erstatter kladden, men lokale valg (gusmester, tekstrettelser) bevares,
  // og gusmester-variantens billede følger det nye valg.
  function mergeServerDraft(draft, serverDraft) {
    const local = draft.localEdit ? structuredClone({
      status: draft.status,
      manualInstructor: draft.manualInstructor,
      event: draft.event,
      platformCopies: draft.platformCopies,
      warnings: draft.warnings,
      warningsAcknowledged: draft.warningsAcknowledged,
      history: draft.history,
    }) : null;
    Object.assign(draft, serverDraft, { localEdit: false });
    if (!local) return;
    Object.assign(draft, local, { localEdit: true });
    const key = Object.keys(draft.instructorOptions || {})
      .find((name) => draft.instructorOptions[name].instructor === draft.manualInstructor);
    if (key) {
      draft.renderPath = draft.instructorOptions[key].renderPath;
      draft.render = structuredClone(draft.instructorOptions[key].render);
    }
  }

  function pickerState(draft) {
    if (!pickers.has(draft.draftId)) pickers.set(draft.draftId, { open: false, assets: null, error: null });
    return pickers.get(draft.draftId);
  }

  async function togglePicker(draft) {
    const state = pickerState(draft);
    state.open = !state.open;
    if (state.open && !state.assets) {
      state.error = null;
      try {
        const response = await fetch(new URL(`assets?draftId=${encodeURIComponent(draft.draftId)}`, apiBase).href);
        if (!response.ok) throw new Error(`http_${response.status}`);
        state.assets = (await response.json()).assets || [];
      } catch {
        state.error = 'Billederne kunne ikke hentes. Genindlæs siden.';
      }
    }
    render();
  }

  async function changeImage(draft, assetId) {
    if (!canApprove || busy) return;
    // Kun et allerede godkendt opslag mister sin godkendelse; kladder skifter uden ekstra klik.
    if (draft.status === 'approved'
      && !window.confirm('Opslaget er godkendt. Et nyt billede fjerner godkendelsen, og opslaget skal godkendes igen. Skift billede?')) return;
    busy = true;
    render();
    let response;
    try {
      const reply = await fetch(new URL('change-image', apiBase).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-soma-key': session.key },
        body: JSON.stringify({ draftId: draft.draftId, contentRevision: draft.contentRevision, assetId }),
      });
      response = reply.ok ? await reply.json() : { error: `http_${reply.status}` };
    } catch {
      response = { error: 'network' };
    }
    busy = false;
    const result = (response.results || []).find((item) => item.draftId === draft.draftId);
    if (result?.outcome === 'changed' && response.pushed && result.draft) {
      mergeServerDraft(draft, result.draft);
      sendMessages.delete(draft.draftId);
      const state = pickerState(draft);
      state.open = false;
      // Galleriet hentes igen næste gang, så skjulte søskendebilleder altid er opdaterede.
      state.assets = null;
      persistDrafts();
    } else {
      sendMessages.set(draft.draftId, OUTCOME_MESSAGES[result?.outcome]
        || `Billedet blev ikke skiftet (${response.error || 'ukendt fejl'}). Prøv igen.`);
    }
    render();
  }

  function buildImagePicker(draft) {
    const wrap = document.createElement('div');
    wrap.className = 'image-picker';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = pickerState(draft).open ? 'Luk billeder' : 'Skift billede';
    toggle.disabled = busy || !canApprove;
    toggle.addEventListener('click', () => { togglePicker(draft); });
    wrap.append(toggle);
    const state = pickerState(draft);
    if (!state.open) return wrap;
    const grid = document.createElement('div');
    grid.className = 'asset-grid';
    if (state.error) {
      const error = document.createElement('p');
      error.className = 'warning';
      error.textContent = state.error;
      grid.append(error);
    } else if (!state.assets) {
      grid.textContent = 'Henter billeder…';
    } else {
      for (const asset of state.assets) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = `asset-choice${asset.assetId === draft.assetId ? ' current' : ''}`;
        choice.disabled = busy || asset.assetId === draft.assetId;
        choice.setAttribute('aria-label', `Vælg billedet ${asset.assetId}`);
        const thumb = document.createElement('img');
        thumb.loading = 'lazy';
        thumb.alt = '';
        thumb.src = new URL(`asset-image/${encodeURIComponent(asset.assetId)}`, apiBase).href;
        const caption = document.createElement('span');
        caption.textContent = asset.assetId === draft.assetId ? 'Nuværende' : asset.assetId;
        choice.append(thumb, caption);
        choice.addEventListener('click', () => { changeImage(draft, asset.assetId); });
        grid.append(choice);
      }
    }
    wrap.append(grid);
    return wrap;
  }

  function eventLabel(event) {
    const weekday = new Date(`${event.date}T12:00:00Z`).getUTCDay();
    const isSoren = /søren/i.test(event.instructor || '');
    if (/mille\s*maja/i.test(event.instructor || '')) return 'Gus med MilleMaja';
    if (weekday === 2 && isSoren) return 'Powergus';
    if (weekday === 2) return 'Tirsdagsgus';
    if (weekday === 4) return `Torsdagsgus${event.instructor && !isSoren ? ` med ${event.instructor}` : ''}`;
    if (weekday === 0) return `Søndagsgus${event.instructor && !isSoren ? ` med ${event.instructor}` : ''}`;
    return `Gus${event.instructor && !isSoren ? ` med ${event.instructor}` : ''}`;
  }

  function formatDanishDate(date) {
    const [year, month, day] = date.split('-').map(Number);
    return new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(year, month - 1, day)));
  }

  function draftHasUpcomingEvent(draft, now = new Date()) {
    const events = draft.kind === 'weekly_overview' ? draft.events : [draft.event];
    if (!Array.isArray(events) || events.length === 0) return false;
    return events.some((event) => {
      if (!event?.date || !event?.end) return false;
      const end = new Date(`${event.date}T${event.end}:00`);
      return Number.isFinite(end.getTime()) && end.getTime() > now.getTime();
    });
  }

  function visibleDrafts() {
    return drafts.filter((draft) => draft.status !== 'obsolete' && draftHasUpcomingEvent(draft));
  }

  function setPreviewSource(image, renderPath, version = '') {
    const normalized = String(renderPath).replace(/\\/g, '/');
    const candidates = (normalized.startsWith('renders/')
      ? [`../${normalized}`, `../../../${normalized}`]
      : [normalized])
      // Samme filnavn bruges ved billedskift; versionen tvinger browseren til at hente det nye billede.
      .map((candidate) => (version ? `${candidate}?v=${encodeURIComponent(version)}` : candidate));
    let index = 0;
    image.addEventListener('error', () => {
      index += 1;
      if (index < candidates.length) image.src = candidates[index];
    });
    image.src = candidates[0];
  }

  // Gusmester-valget gemmes på serveren for hele eventet (begge opslag og ugeoverblik) og kræver ingen eksport.
  async function chooseInstructorOnServer(draft, optionKey) {
    if (!canApprove || busy) { render(); return; }
    const warnings = [];
    if (draft.localEdit) warnings.push('Dine ikke-gemte tekstrettelser på opslaget fjernes, og teksten laves igen med gusmesteren.');
    if (draft.status === 'approved') warnings.push('Opslaget er godkendt og mister godkendelsen.');
    if (warnings.length && !window.confirm(`${warnings.join(' ')} Vælg gusmester?`)) { render(); return; }
    busy = true;
    render();
    let response;
    try {
      const reply = await fetch(new URL('choose-instructor', apiBase).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-soma-key': session.key },
        body: JSON.stringify({ draftId: draft.draftId, contentRevision: draft.contentRevision, option: optionKey }),
      });
      response = reply.ok ? await reply.json() : { error: `http_${reply.status}` };
    } catch {
      response = { error: 'network' };
    }
    busy = false;
    const result = (response.results || []).find((item) => item.draftId === draft.draftId);
    if (result?.outcome === 'changed' && response.pushed && Array.isArray(result.drafts)) {
      for (const serverDraft of result.drafts) {
        const local = drafts.find((item) => item.draftId === serverDraft.draftId);
        if (!local) continue;
        Object.assign(local, serverDraft, { localEdit: false });
        sendMessages.delete(local.draftId);
        pickerState(local).assets = null;
      }
      persistDrafts();
    } else {
      sendMessages.set(draft.draftId, OUTCOME_MESSAGES[result?.outcome]
        || `Gusmesteren blev ikke gemt (${response.error || 'ukendt fejl'}). Prøv igen.`);
    }
    render();
  }

  function render() {
    root.textContent = '';
    const approveAllButton = document.querySelector('#approve-all');
    if (approveAllButton) approveAllButton.disabled = busy || !canApprove;
    const visible = visibleDrafts();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Der er ingen aktuelle kladder.';
      root.append(empty);
      return;
    }
    for (const draft of visible) {
      const platform = active.get(draft.draftId) || 'instagram';
      const card = document.createElement('article');
      card.className = 'draft';
      card.dataset.draftId = draft.draftId;
      const preview = document.createElement('div');
      preview.className = 'preview';
      if (draft.renderPath) {
        const img = document.createElement('img');
        setPreviewSource(img, draft.renderPath, draft.render?.sha256 || draft.contentRevision);
        img.alt = `Opslagsbillede til ${draft.event?.name || 'SOMA gus'}`;
        preview.append(img);
      }
      preview.append(buildImagePicker(draft));
      const editor = document.createElement('section');
      const status = document.createElement('p');
      status.className = 'status';
      status.textContent = draft.status;
      const title = document.createElement('h2');
      title.textContent = draft.event?.name || draft.kind || 'Ugeoverblik';
      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = dateLabel(draft.event) || draft.scheduledFor;
      editor.append(status, title, meta);
      if (draft.instructorOptions && draft.eventKey) {
        const label = document.createElement('label');
        label.className = 'instructor-picker';
        label.textContent = 'Gusmester';
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Vælg gusmester');
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Vælg gusmester…';
        select.append(placeholder);
        for (const [key, choice] of Object.entries(draft.instructorOptions)) {
          const option = document.createElement('option');
          option.value = key;
          option.textContent = choice.instructor;
          option.selected = draft.manualInstructor === choice.instructor;
          select.append(option);
        }
        select.disabled = busy || !canApprove;
        select.addEventListener('change', () => {
          if (select.value) chooseInstructorOnServer(draft, select.value);
        });
        label.append(select);
        editor.append(label);
      } else if (draft.event?.instructor) {
        const label = document.createElement('div');
        label.className = 'instructor-picker';
        label.textContent = 'Gusmester';
        const value = document.createElement('span');
        value.className = 'instructor-value';
        value.textContent = draft.event.instructor;
        label.append(value);
        editor.append(label);
      }
      if (draft.warnings?.length) {
        const warning = document.createElement('p');
        warning.className = 'warning';
        warning.textContent = `Kræver tjek: ${draft.warnings.join(', ')}`;
        editor.append(warning);
        if (draft.status === 'needs_review') {
          const acknowledge = document.createElement('button');
          acknowledge.type = 'button';
          acknowledge.textContent = 'Jeg har kontrolleret advarslen';
          acknowledge.addEventListener('click', () => {
            draft.warningsAcknowledged = true;
            draft.localEdit = true;
            setStatus(draft, 'draft', 'acknowledge_warnings');
            render();
          });
          editor.append(acknowledge);
        }
      }
      const tabs = document.createElement('div');
      tabs.className = 'tabs';
      for (const [key, label] of platforms) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = key === platform ? 'active' : '';
        button.addEventListener('click', () => { active.set(draft.draftId, key); render(); });
        tabs.append(button);
      }
      const textarea = document.createElement('textarea');
      textarea.dataset.platform = platform;
      textarea.value = draft.platformCopies?.[platform] || '';
      const actions = document.createElement('div');
      actions.className = 'actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = 'Gem ændringer';
      save.addEventListener('click', () => {
        draft.platformCopies[platform] = textarea.value.trim();
        draft.localEdit = true;
        setStatus(draft, 'draft', 'edit');
        render();
      });
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Godkend opslag';
      approve.disabled = busy || !canApprove || draft.status === 'needs_review' || Boolean(draft.localEdit);
      approve.addEventListener('click', () => { approveDrafts([draft]); });
      actions.append(save, approve);
      editor.append(tabs, textarea, actions);
      const hint = !canApprove
        ? 'Åbn siden via ÅBN SOMA GODKENDELSE for at godkende.'
        : (draft.localEdit ? 'Rettelser skal eksporteres og importeres, før opslaget kan godkendes.' : '');
      if (hint) {
        const hintLine = document.createElement('p');
        hintLine.className = 'hint';
        hintLine.textContent = hint;
        editor.append(hintLine);
      }
      if (sendMessages.has(draft.draftId)) {
        const sendStatus = document.createElement('p');
        sendStatus.className = 'send-status warning';
        sendStatus.textContent = sendMessages.get(draft.draftId);
        editor.append(sendStatus);
      }
      card.append(preview, editor);
      root.append(card);
    }
  }

  const approveAll = document.querySelector('#approve-all');
  approveAll.disabled = !canApprove;
  approveAll.addEventListener('click', () => {
    approveDrafts(visibleDrafts().filter((draft) =>
      draft.status !== 'needs_review' && draft.status !== 'approved' && !draft.localEdit));
  });

  document.querySelector('#export').addEventListener('click', () => {
    const exported = drafts.map(({ localEdit, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'drafts-reviewed.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });

  render();
})();
