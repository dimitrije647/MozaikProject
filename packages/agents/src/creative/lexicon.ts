/**
 * Promise and proof words per campaign language, for the Reviewer's deterministic claim check. A "hard" word is a
 * guarantee, refund promise, award or testimonial (a blocker when the material does not support it); a "soft" word is a
 * superlative, a count of customers, a discount, "free" or urgency (major). English is always checked as well, because
 * English marketing words leak into copy in every language. Matching runs on text with diacritics folded (č -> c,
 * ä -> a, é -> e), so the patterns are plain ASCII and a missing accent in the copy does not hide a word.
 *
 * These lists are starting points, not linguistics: they catch the common wording and the model review judges the rest.
 */
export interface PromiseLexicon {
  hard: RegExp[];
  soft: RegExp[];
}

export const PROMISE_LEXICONS: Record<string, PromiseLexicon> = {
  en: {
    hard: [/guarantee[sd]?/, /risk[- ]free/, /money[- ]back/, /award[- ]winning|awarded/, /testimonials?/],
    soft: [/#\s?1|number one/, /best (?:in|of|on)\b/, /certified by/, /\d[\d,.]*\+?\s*(?:happy\s+)?(?:customers|clients|students|users|members|reviews|participants)/, /\d+\s*(?:years?|stars?)\b/, /\d+\s?%\s?off/, /discount/, /free (?:trial|gift|shipping|lesson|session)/, /limited[- ]time/, /sale\b/, /100\s?%/],
  },
  sr: {
    hard: [/garantuj\w*|garancij\w*|garantovan\w*/, /bez rizika/, /povrat\w* novca|vracamo novac/, /nagradivan\w*|nagraden\w*/, /svedocanstv\w*|utisci (?:nasih )?(?:klijenata|kupaca|polaznika|korisnika)/],
    soft: [/najbolj\w*/, /broj 1\b|br\. ?1\b|prvi u (?:gradu|srbiji|regionu|zemlji)/, /\d[\d.,]*\+?\s*(?:zadovoljn\w+\s+)?(?:klijenata|kupaca|polaznika|korisnika|ucenika|clanova|recenzija|ocena)/, /\d+\s*(?:godin\w*|zvezdic\w*|zvezda)\b/, /\d+\s?%\s?(?:popust\w*|jeftinije|nize)|popust\w*|akcij\w*|snizenj\w*|rasprodaj\w*/, /besplat\w*/, /ogranicen\w* (?:vreme|ponuda|rok|kolicin\w*)|samo (?:danas|sada|ove nedelje)|pozuri\w*/, /sertifikovan\w* od/, /100\s?%/],
  },
  hr: {
    hard: [/garantir\w*|garancij\w*|jamstv\w*|jamci\w*/, /bez rizika/, /povrat\w* novca/, /nagradivan\w*|nagraden\w*/, /svjedocanstv\w*|iskustva (?:nasih )?(?:klijenata|kupaca|polaznika|korisnika)/],
    soft: [/najbolj\w*/, /broj 1\b|br\. ?1\b|prvi u (?:gradu|hrvatskoj|regiji|zemlji)/, /\d[\d.,]*\+?\s*(?:zadovoljn\w+\s+)?(?:klijenata|kupaca|polaznika|korisnika|ucenika|clanova|recenzija|ocjena)/, /\d+\s*(?:godin\w*|zvjezdic\w*)\b/, /\d+\s?%\s?(?:popust\w*|jeftinije|nize)|popust\w*|akcij\w*|snizenj\w*|rasprodaj\w*/, /besplat\w*/, /ogranicen\w* (?:vrijeme|ponuda|rok|kolicin\w*)|samo (?:danas|sada|ovaj tjedan)|pozuri\w*/, /certificiran\w* od/, /100\s?%/],
  },
  de: {
    hard: [/garantie\w*|garantier\w*/, /risikofrei|ohne risiko/, /geld[- ]zuruck/, /preisgekront\w*|ausgezeichnet\w*/, /erfahrungsbericht\w*|kundenstimme\w*|testimonial\w*/],
    soft: [/(?:der|die|das) beste\w*|beste[rsn]?\b/, /nr\. ?1\b|nummer (?:1|eins)\b/, /\d[\d.,]*\+?\s*(?:zufriedene\s+)?(?:kunden|klienten|teilnehmer|nutzer|mitglieder|bewertungen)/, /\d+\s*(?:jahre|sterne)\b/, /rabatt\w*|\d+\s?%\s?(?:rabatt|gunstiger|sparen)|sale\b/, /kostenlos\w*|gratis/, /nur (?:heute|jetzt|fur kurze zeit)|begrenzt\w*|limitiert\w*/, /zertifiziert von/, /100\s?%/],
  },
  es: {
    hard: [/garantia\w*|garantiz\w*/, /sin riesgo/, /devolucion del dinero|te devolvemos el dinero/, /premiad\w*|galardonad\w*/, /testimonio\w*/],
    soft: [/(?:el|la|los|las) mejor\w*|mejor\w* (?:de|en)\b/, /numero (?:1|uno)\b|n[º°]\s?1\b/, /\d[\d.,]*\+?\s*(?:clientes|alumnos|usuarios|miembros|resenas)/, /\d+\s*(?:anos|estrellas)\b/, /descuento\w*|\d+\s?%\s?(?:de descuento|menos)|rebaja\w*/, /gratis|gratuit\w*/, /solo (?:hoy|ahora)|tiempo limitado/, /certificad\w* por/, /100\s?%/],
  },
  fr: {
    hard: [/garanti\w*/, /sans risque/, /satisfait ou rembourse|rembours\w*/, /recompense\w*|prime\w* par/, /temoignage\w*/],
    soft: [/(?:le|la|les) meilleur\w*|meilleur\w* (?:de|en)\b/, /n[°o]\s?1\b|numero (?:1|un)\b/, /\d[\d.,]*\+?\s*(?:clients|eleves|utilisateurs|membres|avis)/, /\d+\s*(?:ans|etoiles)\b/, /remise\w*|reduction\w*|\d+\s?%\s?(?:de remise|de reduction|moins cher)|promo\w*|soldes/, /gratuit\w*/, /seulement (?:aujourd'hui|maintenant)|offre limitee|duree limitee/, /certifie\w* par/, /100\s?%/],
  },
  it: {
    hard: [/garanti\w*|garanzia/, /senza rischi?\b/, /soddisfatti o rimborsati|rimbors\w*/, /premiat\w*/, /testimonianz\w*/],
    soft: [/(?:il|la|i|le) miglior\w*|miglior\w* (?:di|in)\b/, /numero (?:1|uno)\b|n[°.]\s?1\b/, /\d[\d.,]*\+?\s*(?:clienti|allievi|utenti|membri|recensioni)/, /\d+\s*(?:anni|stelle)\b/, /scont\w*|\d+\s?%\s?(?:di sconto|in meno)|saldi\b/, /gratis|gratuit\w*/, /solo (?:oggi|ora)|tempo limitato|offerta limitata/, /certificat\w* da/, /100\s?%/],
  },
};

const FOLD: Record<string, string> = {
  č: 'c', ć: 'c', š: 's', ž: 'z', đ: 'd', ä: 'a', ö: 'o', ü: 'u', ß: 's', é: 'e', è: 'e', ê: 'e', ë: 'e', à: 'a', â: 'a', á: 'a', ã: 'a', å: 'a', æ: 'a', ç: 'c', ñ: 'n',
  í: 'i', ì: 'i', î: 'i', ï: 'i', ó: 'o', ò: 'o', ô: 'o', õ: 'o', ø: 'o', œ: 'o', ú: 'u', ù: 'u', û: 'u', ý: 'y', ÿ: 'y', ł: 'l', ś: 's', ź: 'z', ż: 'z', ń: 'n', ő: 'o', ű: 'u',
  ă: 'a', ș: 's', ş: 's', ț: 't', ţ: 't', ě: 'e', ř: 'r', ů: 'u', ğ: 'g', ı: 'i',
};

/** Lower-cases and strips diacritics one code point at a time, so indexes into the result map onto the original text. */
export function foldDiacritics(s: string): string {
  return s.replace(/./gu, (ch) => {
    const lower = ch.toLowerCase();
    const one = lower.length === ch.length ? lower : ch;
    return FOLD[one] ?? one;
  });
}

const compile = (list: RegExp[]) => new RegExp(list.map((r) => `(?:${/^[#]/.test(r.source) ? '' : '\\b'}${r.source})`).join('|'), 'gi');
const cache = new Map<string, { hard: RegExp; soft: RegExp }>();

/** The compiled patterns for a campaign language: its own list plus English. */
export function promisePatterns(language: string | undefined): { hard: RegExp; soft: RegExp } {
  const code = (language ?? 'en').toLowerCase().slice(0, 2);
  const key = PROMISE_LEXICONS[code] && code !== 'en' ? code : 'en';
  const cached = cache.get(key);
  if (cached) return cached;
  const own = PROMISE_LEXICONS[key];
  const hard = key === 'en' ? own.hard : [...own.hard, ...PROMISE_LEXICONS.en.hard];
  const soft = key === 'en' ? own.soft : [...own.soft, ...PROMISE_LEXICONS.en.soft];
  const compiled = { hard: compile(hard), soft: compile(soft) };
  cache.set(key, compiled);
  return compiled;
}

export interface PromiseMatch {
  /** The phrase as written in the copy (diacritics intact). */
  phrase: string;
  index: number;
  hard: boolean;
}

/** Every promise or proof phrase in the text, in order of appearance, with the hard/soft distinction. */
export function promiseMatches(text: string, language: string | undefined): PromiseMatch[] {
  const folded = foldDiacritics(text);
  const { hard, soft } = promisePatterns(language);
  const out: PromiseMatch[] = [];
  for (const [re, isHard] of [[hard, true], [soft, false]] as const) {
    re.lastIndex = 0;
    for (const m of folded.matchAll(re)) out.push({ phrase: text.slice(m.index, m.index + m[0].length), index: m.index, hard: isHard });
  }
  return out.sort((a, b) => a.index - b.index);
}
