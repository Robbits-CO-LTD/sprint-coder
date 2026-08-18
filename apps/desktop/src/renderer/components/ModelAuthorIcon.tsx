import type { SVGProps } from 'react';

// Monochrome brand paths are adapted from Simple Icons (CC0-1.0); compact monograms are local
// fallbacks for brands without a bundled path. All marks inherit currentColor and remain decorative.

type Brand =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'meta'
  | 'mistral'
  | 'qwen'
  | 'kimi'
  | 'minimax'
  | 'zai'
  | 'orcarouter'
  | 'unknown';

const ALIASES: Readonly<Record<string, Brand>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'google-ai': 'google',
  'google-gemini': 'google',
  gemini: 'google',
  xai: 'xai',
  'x-ai': 'xai',
  grok: 'xai',
  deepseek: 'deepseek',
  meta: 'meta',
  'meta-llama': 'meta',
  llama: 'meta',
  mistral: 'mistral',
  mistralai: 'mistral',
  qwen: 'qwen',
  alibaba: 'qwen',
  'alibaba-qwen': 'qwen',
  kimi: 'kimi',
  moonshot: 'kimi',
  moonshotai: 'kimi',
  minimax: 'minimax',
  'z-ai': 'zai',
  zai: 'zai',
  zhipu: 'zai',
  zhipuai: 'zai',
  orcarouter: 'orcarouter',
};

const DISPLAY_NAMES: Readonly<Record<Brand, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  mistral: 'Mistral AI',
  qwen: 'Qwen',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  zai: 'Z.ai',
  orcarouter: 'OrcaRouter',
  unknown: '不明',
};

export function modelAuthorBrand(author: string | null | undefined): Brand {
  if (author === null || author === undefined) return 'unknown';
  return ALIASES[author.trim().toLocaleLowerCase()] ?? 'unknown';
}

export function modelAuthorDisplayName(author: string | null | undefined): string {
  const brand = modelAuthorBrand(author);
  return brand === 'unknown' && author?.trim() ? author.trim() : DISPLAY_NAMES[brand];
}

export function ModelAuthorIcon({
  author,
  ...props
}: SVGProps<SVGSVGElement> & { author: string | null | undefined }) {
  const brand = modelAuthorBrand(author);
  const common = {
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': true,
    focusable: false,
    ...props,
  } as const;
  switch (brand) {
    case 'anthropic':
      return (
        <svg {...common}>
          <path d="M17.304 3.541h-3.672l6.696 16.918H24ZM6.696 3.541 0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223 2.291-5.946 2.292 5.946Z" />
        </svg>
      );
    case 'google':
      return (
        <svg {...common}>
          <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
        </svg>
      );
    case 'xai':
      return (
        <svg {...common}>
          <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
        </svg>
      );
    case 'meta':
      return (
        <svg {...common}>
          <path d="M6.9 5.1C3.2 5.1 1 10.4 1 14.5c0 3 1.2 4.5 3.4 4.5 2.4 0 3.8-2.4 6.5-7l1.1-1.8 1.1 1.8c2.7 4.6 4.1 7 6.5 7 2.2 0 3.4-1.5 3.4-4.5 0-4.1-2.2-9.4-5.9-9.4-2.1 0-3.8 1.7-5.1 3.5-1.3-1.8-3-3.5-5.1-3.5m.1 2.5c1.1 0 2.3 1.2 3.5 2.9l-1.4 2.2c-2 3.2-3.1 4-4.4 4-.8 0-1.2-.7-1.2-2.1 0-3 1.5-7 3.5-7m10 0c2 0 3.5 4 3.5 7 0 1.4-.4 2.1-1.2 2.1-1.3 0-2.4-.8-4.4-4l-1.4-2.2c1.2-1.7 2.4-2.9 3.5-2.9" />
        </svg>
      );
    case 'mistral':
      return (
        <svg {...common}>
          <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
        </svg>
      );
    case 'openai':
      return <Rosette {...common} />;
    case 'deepseek':
      return <Monogram {...common}>D</Monogram>;
    case 'qwen':
      return <Monogram {...common}>Q</Monogram>;
    case 'kimi':
      return <Monogram {...common}>K</Monogram>;
    case 'minimax':
      return <Monogram {...common}>M</Monogram>;
    case 'zai':
      return <Monogram {...common}>Z</Monogram>;
    case 'orcarouter':
      return <Monogram {...common}>O</Monogram>;
    case 'unknown':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2" />
          <path d="m6.3 7.2 4.1 3.6M17.7 7.2l-4.1 3.6M12 14v5" />
        </svg>
      );
  }
}

function Monogram({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props}>
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <text
        x="12"
        y="16.2"
        textAnchor="middle"
        fontSize="12"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
      >
        {children}
      </text>
    </svg>
  );
}

function Rosette(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5a4.6 4.6 0 0 1 4 6.9 4.6 4.6 0 0 1 2 8.1 4.6 4.6 0 0 1-8 1.2 4.6 4.6 0 0 1-6-5.7 4.6 4.6 0 0 1 2-8.1A4.6 4.6 0 0 1 12 2.5Z" />
    </svg>
  );
}
