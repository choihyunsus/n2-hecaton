// Deterministic ten-domain classification retains every domain attached to a shared keyword.
import type { ToolMetadata } from './types';

export interface Classification {
  domain: string;
  area: string;
  domainBit: number;
  areaBit: number;
}
interface Area {
  name: string;
  words: string[];
}
interface Domain {
  name: string;
  aliases: string[];
  areas: Area[];
}
const area = (name: string, words: string): Area => ({ name, words: words.split(' ') });
const DOMAINS: Domain[] = [
  {
    name: 'file',
    aliases: [],
    areas: [
      area(
        'read',
        'read cat view file content text line glob find pattern grep search regex match',
      ),
      area('write', 'write create save output edit replace modify update patch'),
    ],
  },
  {
    name: 'shell',
    aliases: ['system'],
    areas: [area('exec', 'shell exec run command process program binary')],
  },
  {
    name: 'web',
    aliases: [],
    areas: [
      area('search', 'web search google duckduckgo internet online'),
      area('fetch', 'fetch url http get download webpage markdown crawl'),
      area('study', 'study learn research knowledge auto'),
    ],
  },
  {
    name: 'task',
    aliases: [],
    areas: [
      area(
        'manage',
        'task background spawn process daemon job status info list output stdout log stop kill terminate cancel',
      ),
    ],
  },
  {
    name: 'security',
    aliases: [],
    areas: [area('check', 'check safety classify threat approve permission authorize allow')],
  },
  {
    name: 'memory',
    aliases: ['soul'],
    areas: [
      area('mimir', 'mimir recall remember memory experience insight learn store digest analyze'),
      area('soul', 'soul board state handoff kv cache load save snapshot context'),
    ],
  },
  {
    name: 'browser',
    aliases: [],
    areas: [
      area('navigate', 'browser surf navigate browse goto url'),
      area('interact', 'click tap press button type input keyboard read page content dom som'),
    ],
  },
  {
    name: 'mcp',
    aliases: [],
    areas: [area('call', 'mcp call tool server external resource list read')],
  },
  {
    name: 'agent',
    aliases: ['user'],
    areas: [
      area(
        'manage',
        'agent spawn sub parallel delegate fork dispatch directive assign gumiho worker status slots workers user',
      ),
    ],
  },
  {
    name: 'quality',
    aliases: [],
    areas: [area('scan', 'sindri scan lint quality code review ast')],
  },
];

export function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function queryDomains(words: readonly string[]): number {
  let bits = 0;
  for (const [index, domain] of DOMAINS.entries()) {
    const keywords = [
      domain.name,
      ...domain.aliases,
      ...domain.areas.flatMap((item) => item.words),
    ];
    if (words.some((word) => keywords.includes(word))) bits |= 1 << index;
  }
  return bits;
}

export function classify(
  tool: Pick<ToolMetadata, 'name' | 'category' | 'description'>,
): Classification {
  const words = tokens(tool.name);
  const named = DOMAINS.findIndex((domain) =>
    [domain.name, ...domain.aliases].includes(words[0] ?? ''),
  );
  const category = DOMAINS.findIndex((domain) =>
    [domain.name, ...domain.aliases].includes(tool.category?.toLowerCase() ?? ''),
  );
  const domainBit = named >= 0 ? named : category;
  const candidates = domainBit >= 0 ? [domainBit] : DOMAINS.map((_, index) => index);
  const selectedDomain = domainBit >= 0 ? DOMAINS[domainBit]! : undefined;
  const domainWords = selectedDomain ? [selectedDomain.name, ...selectedDomain.aliases] : [];
  const query = selectedDomain
    ? words.filter((word) => !domainWords.includes(word))
    : [...words, ...tokens(tool.description)];
  let best = { domainBit: domainBit >= 0 ? domainBit : 7, areaBit: 0, score: -1 };
  for (const index of candidates) {
    for (const [areaBit, item] of DOMAINS[index]!.areas.entries()) {
      const score = query.reduce(
        (sum, word) => sum + Number(item.words.includes(word) || item.name === word),
        0,
      );
      if (score > best.score && (score > 0 || domainBit >= 0))
        best = { domainBit: index, areaBit, score };
    }
  }
  const domain = DOMAINS[best.domainBit]!;
  return {
    domain: domain.name,
    area: domain.areas[best.areaBit]!.name,
    domainBit: best.domainBit,
    areaBit: best.areaBit,
  };
}

export function quantize(
  tool: Pick<ToolMetadata, 'name' | 'category' | 'description' | 'readOnly'>,
): {
  bitfield: number;
  dna: string;
  card: string;
} {
  const classified = classify(tool);
  const location = `${classified.domain}.${classified.area}`;
  const access = tool.readOnly ? 'read' : 'write';
  return {
    bitfield: (1 << classified.domainBit) | (classified.areaBit << 10),
    dna: `${tool.name}|${location}|object->result|${access}`,
    card: `${tool.name}\n${location} ${access}\n${Array.from(tool.description).slice(0, 160).join('')}`,
  };
}
