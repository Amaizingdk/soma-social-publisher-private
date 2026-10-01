(() => {
  'use strict';

  const platforms = [
    ['instagram', 'Instagram'],
    ['facebookPage', 'Facebook-side'],
    ['facebookGroup', 'Facebook-gruppe'],
  ];
  const embedded = JSON.parse(document.querySelector('#drafts-data')?.textContent || '[]');
  const storageKey = 'soma-content-planner-review-v1';

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
        return {
          ...draft,
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

  function refreshWeeklyCopy(draft) {
    const list = (draft.events || []).map((event) =>
      `• ${formatDanishDate(event.date)} · ${event.start.replace(':', '.')}–${event.end.replace(':', '.')} · ${eventLabel(event)}`)
      .join('\n');
    const booking = 'https://somasaunagus.dk/kalender/';
    draft.platformCopies = {
      instagram: `Næste uges gus 🔥\n\n${list}\n\nSe tider og book via kalenderen: ${booking}`,
      facebookPage: `Her er næste uges gus. Hver session har sit eget udtryk, men altid med plads til ro, varme, dufte, musik og nærvær.\n\n${list}\n\nFind den oplevelse, der passer dig, og book din plads her: ${booking}`,
      facebookGroup: `Kære alle ❤️\n\nHer er næste uges muligheder for at finde ro i varmen:\n\n${list}\n\nJeg glæder mig til at se jer. Booking: ${booking}`,
    };
    setStatus(draft, 'draft', 'select_instructor');
  }

  function applyInstructor(eventKey, optionKey) {
    for (const draft of drafts) {
      if (draft.status === 'obsolete') continue;
      if (draft.eventKey === eventKey && draft.instructorOptions?.[optionKey]) {
        const choice = draft.instructorOptions[optionKey];
        draft.manualInstructor = choice.instructor;
        if (draft.event) draft.event.instructor = choice.instructor;
        draft.platformCopies = structuredClone(choice.platformCopies);
        draft.renderPath = choice.renderPath;
        draft.render = structuredClone(choice.render);
        draft.warnings = [];
        draft.warningsAcknowledged = true;
        setStatus(draft, 'draft', 'select_instructor');
      }
      const weeklyEvent = draft.events?.find((event) => event.eventKey === eventKey);
      if (weeklyEvent) {
        const sample = drafts.find((item) => item.eventKey === eventKey && item.instructorOptions?.[optionKey]);
        weeklyEvent.instructor = sample.instructorOptions[optionKey].instructor;
        refreshWeeklyCopy(draft);
      }
    }
    render();
  }

  function render() {
    root.textContent = '';
    const visible = drafts.filter((draft) => draft.status !== 'obsolete');
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
        img.src = draft.renderPath;
        img.alt = `Opslagsbillede til ${draft.event?.name || 'SOMA gus'}`;
        preview.append(img);
      }
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
        select.addEventListener('change', () => {
          if (select.value) applyInstructor(draft.eventKey, select.value);
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
        setStatus(draft, 'draft', 'edit');
        render();
      });
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Godkend opslag';
      approve.disabled = draft.status === 'needs_review';
      approve.addEventListener('click', () => { setStatus(draft, 'approved', 'approve'); render(); });
      actions.append(save, approve);
      editor.append(tabs, textarea, actions);
      card.append(preview, editor);
      root.append(card);
    }
  }

  document.querySelector('#approve-all').addEventListener('click', () => {
    drafts.filter((draft) => draft.status !== 'obsolete' && draft.status !== 'needs_review')
      .forEach((draft) => setStatus(draft, 'approved', 'approve'));
    render();
  });

  document.querySelector('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(drafts, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'drafts-reviewed.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });

  render();
})();
