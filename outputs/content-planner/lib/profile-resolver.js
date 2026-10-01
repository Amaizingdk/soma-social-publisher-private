'use strict';

function normalizePersonName(value) {
  return String(value ?? '').toLocaleLowerCase('da-DK').replace(/\s+/g, ' ').trim();
}

function validateProfiles(registry) {
  if (!registry || !Array.isArray(registry.profiles)) throw new Error('Profiles skal indeholde profiles-array');
  const ids = new Set();
  const aliases = new Set();
  for (const profile of registry.profiles) {
    if (!profile.profileId || ids.has(profile.profileId)) throw new Error(`Profil-id mangler eller er dublet: ${profile.profileId}`);
    ids.add(profile.profileId);
    if (!Array.isArray(profile.facts) || !Array.isArray(profile.hooks) || !Array.isArray(profile.invitations)) {
      throw new Error(`Profil ${profile.profileId} mangler godkendte tekstblokke`);
    }
    for (const alias of profile.aliases || []) {
      const normalized = normalizePersonName(alias);
      if (!normalized || aliases.has(normalized)) throw new Error(`Alias er tomt eller dublet: ${alias}`);
      aliases.add(normalized);
    }
  }
  if (!ids.has('neutral')) throw new Error('Neutral profil mangler');
}

function validateOverrides(registry) {
  if (!registry || !Array.isArray(registry.overrides)) throw new Error('Overrides skal indeholde overrides-array');
  const ids = new Set();
  for (const override of registry.overrides) {
    if (!override.overrideId || ids.has(override.overrideId)) throw new Error(`Override-id mangler eller er dublet: ${override.overrideId}`);
    ids.add(override.overrideId);
    if (!override.match?.date || !override.match?.start) throw new Error(`Override ${override.overrideId} mangler dato/start`);
    if (!Array.isArray(override.approvedFacts) || override.approvedFacts.length === 0) {
      throw new Error(`Override ${override.overrideId} mangler approvedFacts`);
    }
  }
}

function matchesOverride(event, override) {
  const match = override.match;
  if (event.date !== match.date || event.start !== match.start) return false;
  if (match.nameIncludes && !event.name.toLocaleLowerCase('da-DK').includes(match.nameIncludes.toLocaleLowerCase('da-DK'))) return false;
  if (match.instructorAliases) {
    const instructor = normalizePersonName(event.instructor);
    if (!match.instructorAliases.map(normalizePersonName).includes(instructor)) return false;
  }
  return !override.expiresAfter || event.date <= override.expiresAfter;
}

function contentFromProfile(profile, event, warnings = []) {
  const weekday = new Date(`${event.date}T12:00:00Z`).getUTCDay();
  const weekdayProfile = profile.weekdayProfiles?.[String(weekday)];
  const weekdayFacts = Array.isArray(weekdayProfile) ? weekdayProfile : (weekdayProfile?.facts || []);
  const variantFacts = (weekdayProfile?.variants || []).map((variant) => variant.fact).filter(Boolean);
  return {
    kind: profile.profileId === 'neutral' ? 'neutral' : 'instructor_profile',
    profileId: profile.profileId,
    displayName: profile.displayName,
    creditLine: profile.creditLine,
    facts: [...profile.facts, ...weekdayFacts, ...variantFacts],
    tone: [...(profile.tone || [])],
    hooks: [...profile.hooks],
    invitations: [...profile.invitations],
    copyVariants: [...(weekdayProfile?.variants || [])],
    warnings,
    automaticUseAllowed: Boolean(profile.automaticUseAllowed) && warnings.length === 0,
  };
}

function resolveContentSource(event, profileRegistry, overrideRegistry) {
  validateProfiles(profileRegistry);
  validateOverrides(overrideRegistry);
  const override = overrideRegistry.overrides.find((candidate) => matchesOverride(event, candidate));
  if (override) {
    return {
      kind: 'event_override',
      profileId: 'millemaja',
      displayName: 'MilleMaja',
      creditLine: override.creditLine,
      title: override.title,
      facts: [...override.approvedFacts],
      tone: [...(override.tone || [])],
      hooks: [...(override.hooks || [])],
      invitations: [...(override.invitations || [])],
      warnings: [],
      automaticUseAllowed: Boolean(override.automaticUseAllowed),
      sourceId: `override:${override.overrideId}`,
    };
  }

  const normalizedInstructor = normalizePersonName(event.instructor);
  const known = profileRegistry.profiles.find((profile) =>
    (profile.aliases || []).map(normalizePersonName).includes(normalizedInstructor));
  if (known && normalizedInstructor) return contentFromProfile(known, event);

  const neutral = profileRegistry.profiles.find((profile) => profile.profileId === 'neutral');
  const warning = normalizedInstructor ? 'unknown_instructor' : 'instructor_missing';
  return {
    ...contentFromProfile(neutral, event, [warning]),
    displayName: normalizedInstructor ? String(event.instructor).trim() : null,
  };
}

module.exports = {
  normalizePersonName,
  validateProfiles,
  validateOverrides,
  resolveContentSource,
};
