const USER_AGENT = 'Mozilla/5.0 (compatible; AgentPageExtract/1.0; +https://apify.com)';

export { USER_AGENT };

export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const splitAt = line.indexOf(':');
    if (splitAt === -1) continue;
    const key = line.slice(0, splitAt).trim().toLowerCase();
    const value = line.slice(splitAt + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.hasRules) {
        current = { agents: [], rules: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [], hasRules: false };
        groups.push(current);
      }
      current.hasRules = true;
      if (value) current.rules.push({ type: key, path: value });
    }
  }
  return groups;
}

function ruleMatches(pattern, path) {
  const endAnchored = pattern.endsWith('$');
  const core = endAnchored ? pattern.slice(0, -1) : pattern;
  const parts = core.split('*');
  if (parts.length === 1) {
    return endAnchored ? path === core : path.startsWith(core);
  }
  let index = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    const found = path.indexOf(part, index);
    if (found === -1) return false;
    if (i === 0 && !core.startsWith('*') && found !== 0) return false;
    index = found + part.length;
  }
  const last = parts[parts.length - 1];
  if (endAnchored && last && !path.endsWith(last)) return false;
  return true;
}

export function matchingRules(groups, userAgent = USER_AGENT) {
  const ua = String(userAgent || USER_AGENT).toLowerCase();
  let bestLen = 0;
  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent !== '*' && ua.includes(agent) && agent.length > bestLen) bestLen = agent.length;
    }
  }
  if (bestLen > 0) {
    return groups
      .filter((group) => group.agents.some((agent) => agent !== '*' && ua.includes(agent) && agent.length === bestLen))
      .flatMap((group) => group.rules);
  }
  return groups.filter((group) => group.agents.includes('*')).flatMap((group) => group.rules);
}

export function robotsAllow(groups, url, userAgent = USER_AGENT) {
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;
  const rules = matchingRules(groups, userAgent);
  let winner = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (!winner || rule.path.length > winner.path.length) winner = rule;
    else if (rule.path.length === winner.path.length && rule.type === 'allow') winner = rule;
  }
  if (!winner) return true;
  return winner.type === 'allow';
}

export async function loadRobots(origin, fetchImpl = globalThis.fetch, userAgent = USER_AGENT) {
  try {
    const response = await fetchImpl(new URL('/robots.txt', origin), {
      headers: { 'user-agent': userAgent, accept: 'text/plain' },
      redirect: 'follow',
    });
    if (!response.ok) return [];
    return parseRobots(await response.text());
  } catch {
    return [];
  }
}
