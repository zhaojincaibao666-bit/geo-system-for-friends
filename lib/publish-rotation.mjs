const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

export function musicRotationKey(music = {}) {
  const title = normalize(music?.title);
  if (!title) return '';
  return [title, normalize(music?.author), normalize(music?.duration)].join('|');
}

export function initialMusicRotation(drafts = []) {
  const usedKeys = [];
  for (const draft of [...drafts].reverse()) {
    const key = draft.music?.rotationKey || musicRotationKey(draft.music);
    if (key && !usedKeys.includes(key)) usedKeys.push(key);
  }
  return { cycle: 1, usedKeys, lastSelectedKey: usedKeys.at(-1) || null, updatedAt: null };
}

export function chooseRotatingMusic(candidates = [], usedKeys = []) {
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.rotationKey || musicRotationKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...candidate, rotationKey: key });
  }
  if (!unique.length) return null;
  const used = new Set(usedKeys);
  const available = unique.find(candidate => !used.has(candidate.rotationKey));
  return {
    candidate: available || unique[0],
    cycleRestarted: !available,
    favoriteCount: unique.length,
  };
}

export function rotatePhotoCandidates(candidates = [], drafts = [], { limit = 7, random = Math.random } = {}) {
  const eligibleDrafts = drafts.filter(draft => !['failed', 'rejected'].includes(draft.status) && Array.isArray(draft.imageIds) && draft.imageIds.length);
  const recentIds = new Set(eligibleDrafts.slice(0, 5).flatMap(draft => draft.imageIds));
  const stats = new Map();
  for (const draft of eligibleDrafts) {
    for (const id of new Set(draft.imageIds)) {
      const current = stats.get(id) || { useCount: 0, lastUsedAt: null };
      current.useCount += 1;
      if (!current.lastUsedAt || Date.parse(draft.updatedAt || draft.createdAt || 0) > Date.parse(current.lastUsedAt || 0)) {
        current.lastUsedAt = draft.updatedAt || draft.createdAt || null;
      }
      stats.set(id, current);
    }
  }
  return candidates.map(asset => {
    const usage = stats.get(asset.id) || { useCount: 0, lastUsedAt: null };
    return {
      ...asset,
      rotationUseCount: usage.useCount,
      rotationLastUsedAt: usage.lastUsedAt,
      rotationRecentlyUsed: recentIds.has(asset.id),
      rotationTieBreaker: random(),
    };
  }).sort((a, b) => Number(a.rotationRecentlyUsed) - Number(b.rotationRecentlyUsed)
    || a.rotationUseCount - b.rotationUseCount
    || Date.parse(a.rotationLastUsedAt || 0) - Date.parse(b.rotationLastUsedAt || 0)
    || a.rotationTieBreaker - b.rotationTieBreaker)
    .slice(0, Math.max(0, limit))
    .map(({ rotationTieBreaker, ...asset }) => asset);
}
