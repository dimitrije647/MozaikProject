import type { ChannelId } from '../strategy/channels';
import { STYLE_IDS, type StyleDef, type StyleId, type TemplateCategory } from './schema';

/**
 * THE LOCAL STYLE LIBRARY. Ten ORIGINAL visual styles, written for LaunchPilot. They are our own art-direction vocabulary (typography
 * hierarchy, color logic, composition, photography direction, density, decorative rules); nothing here is copied from a website, a brand or
 * a template marketplace. Every line is concrete enough to drop into an image prompt ("generous negative space on the left third for the
 * headline") and into a layout decision (density, template categories, channels).
 *
 * Keyword syntax used by the matcher (see matchStyles): lower-case, accents are ignored. A word matches an exact word of the brief (a
 * plural -s/-es/-ies is accepted). A trailing `*` means "starts with" and is used for Serbian/Croatian stems that inflect
 * ("restoran*" = restoran, restorana, restoranu ...). Multi-word keywords match the words in order.
 */

export const STYLES: readonly StyleDef[] = [
  {
    id: 'minimalist_tech',
    name: 'Minimalist Tech',
    description:
      'Calm, precise and spacious. Near-white or near-black surfaces, one confident accent color and tight sans-serif type with a lot of empty space. For software, developer tools, data and AI products.',
    typography: {
      headline: { family: 'sans', weight: 600, case: 'none', tracking: -0.02 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'One headline of 3 to 7 words in semibold sans, one quiet support line at about 40% of the headline size in muted ink, an optional small eyebrow label; never more than three type sizes.',
    },
    color: {
      background: 'light',
      accent: 'mono',
      logic: 'Ink and paper carry about 90% of the surface; the brand primary appears once as the accent (button, one shape or one highlighted word). No gradients between unrelated hues.',
      ink: '#0F1419',
      paper: '#F5F6F8',
    },
    composition: [
      'Keep the left third or the top 40% of the frame empty for the headline',
      'One focal object on a strict left-aligned grid, cropped off one edge',
      'Large calm negative space; at most three elements in the whole frame',
      'Support line and button in a single column under the headline',
    ],
    photography: {
      subjects: [
        'Single device on a clean desk surface in soft window light',
        'Abstract macro of glass, metal or folded paper with a gentle shadow',
        'Hands working on a laptop seen from the side, no face visible',
        'Geometric architecture detail at blue hour',
      ],
      treatment: ['Soft diffuse light, low contrast, desaturated except one accent hue', 'Shallow depth of field with a calm empty area for text', 'Cool neutral white balance, no heavy vignette'],
      avoid: ['Glowing circuits, holograms or binary rain', 'Fake dashboards or screenshots with readable text', 'Stock handshakes and posed headset smiles'],
    },
    density: 'airy',
    decorative: ['A single 1 px hairline rule or a small mono eyebrow label', 'At most one soft glow behind the focal object', 'Small, consistent corner radius; only soft ambient shadows'],
    channels: ['linkedin', 'instagram', 'google_search', 'email', 'organic_content', 'youtube'],
    templateCategories: ['tech_saas', 'professional_services'],
    industries: ['software', 'saas', 'developer tools', 'ai', 'fintech', 'analytics', 'cybersecurity', 'cloud', 'mobile app', 'productivity', 'data', 'automation'],
    keywords: ['minimal', 'minimalist', 'clean', 'precise', 'saas', 'software', 'developer', 'api', 'dashboard', 'platform', 'cloud', 'automation', 'analytics', 'tech', 'technolog*', 'app', 'ai', 'tehnolog*', 'softver*', 'aplikacij*'],
  },
  {
    id: 'premium_editorial',
    name: 'Premium Editorial',
    description:
      'Magazine-like composition with a serif headline, warm paper tones, thin rules and photography given room to breathe. For brands that sell taste, craft and story rather than speed or price.',
    typography: {
      headline: { family: 'serif', weight: 500, case: 'none', tracking: -0.01 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'Serif headline at 2.5 to 3 times the body size, a small tracked uppercase eyebrow above it, one sans support line; contrast comes from scale and weight, not from color.',
    },
    color: {
      background: 'light',
      accent: 'neutral',
      logic: 'Warm paper background, deep ink text and one muted accent taken from the photograph or the brand; the accent colors only a rule, a number or a single word.',
      ink: '#1C1A17',
      paper: '#F3EEE6',
    },
    composition: [
      'Asymmetric two-column layout: image on one side, text block on the other',
      'Headline set large in the upper left, anchored by a thin horizontal rule',
      'Generous margins of at least 8% of the shorter side on every edge',
      'Caption-sized support text; one short line only',
    ],
    photography: {
      subjects: [
        'Still life of handcrafted objects on a textured surface',
        'Portrait of a maker at work, hands and tools in focus',
        'Architectural interior with layered natural light',
        'Fabric, paper or ceramic detail in close crop',
      ],
      treatment: ['Natural window light with soft long shadows', 'Muted, slightly warm color grade with fine grain', 'Rule-of-thirds framing with a quiet area for type'],
      avoid: ['Harsh flash and glossy stock-photo smiles', 'Busy backgrounds and neon colors', 'Heavy filters and drop-shadow text boxes'],
    },
    density: 'balanced',
    decorative: ['Thin hairline rules and a small uppercase eyebrow', 'An optional small category label above the headline', 'No gradients and no rounded buttons; a plain underlined link style'],
    channels: ['instagram', 'facebook', 'linkedin', 'organic_content', 'email'],
    templateCategories: ['editorial_brand', 'ecommerce'],
    industries: ['publishing', 'magazine', 'fashion', 'jewelry', 'interior design', 'architecture', 'design studio', 'art gallery', 'furniture', 'wine', 'cosmetics', 'boutique', 'craft', 'photography'],
    keywords: ['editorial', 'magazine', 'premium', 'elegant', 'refined', 'heritage', 'artisan', 'curated', 'collection', 'craft', 'boutique', 'fashion', 'design', 'interior', 'arhitektur*', 'enterijer*', 'nakit', 'kolekcij*', 'moda', 'dizajn*'],
  },
  {
    id: 'bold_startup',
    name: 'Bold Startup',
    description:
      'Loud, confident and fast. Oversized heavy type, a saturated brand color field, hard contrast and one punchy focal object. For launches, apps and growth-stage companies that want to be noticed in a feed.',
    typography: {
      headline: { family: 'display', weight: 800, case: 'none', tracking: -0.03 },
      body: { family: 'sans', weight: 500 },
      hierarchy: 'Oversized heavy headline of 2 to 6 words filling about 60% of the width, a short support line at one quarter of its size, a high-contrast pill button.',
    },
    color: {
      background: 'brand',
      accent: 'complement',
      logic: 'Full-bleed field in the brand primary with ink or white type; one complementary accent for the button or a single highlighted word. Two hues at most.',
      ink: '#0E1116',
      paper: '#FBFAF6',
    },
    composition: [
      'Headline stacked on two or three lines in the upper left, very large',
      'One hero object or cutout breaking the frame edge at an angle',
      'Solid color blocks instead of photographic backgrounds when no photo exists',
      'Button or sticker shape in the accent color near the lower right',
    ],
    photography: {
      subjects: [
        'Single product or object shot straight on against a flat color',
        'A hand holding a phone with the face cropped out, playful gesture',
        'Cut-out props in saturated colors with hard shadows',
        'Candid team moment in bright daylight, shot close',
      ],
      treatment: ['Hard flash or direct daylight, strong contrast, saturated color', 'Flat color seamless background matching the brand primary', 'Tight crop with the subject large in the frame'],
      avoid: ['Muted pastel moods and soft haze', 'Corporate meeting-room scenes', 'Cluttered backgrounds that compete with the headline'],
    },
    density: 'balanced',
    decorative: ['Sticker-like badges and arrows used sparingly', 'Chunky offset shadow behind the button or the focal shape', 'One oversized number or symbol cropped by the edge'],
    channels: ['instagram', 'tiktok', 'linkedin', 'youtube', 'facebook', 'google_search'],
    templateCategories: ['tech_saas', 'ecommerce'],
    industries: ['startup', 'saas', 'mobile app', 'fintech', 'edtech', 'marketplace', 'consumer app', 'delivery', 'product launch', 'crowdfunding'],
    keywords: ['startup', 'startap*', 'launch', 'lansiranj*', 'growth', 'scale', 'founder', 'beta', 'waitlist', 'mvp', 'bold', 'disrupt', 'fast', 'mobile', 'app', 'new product', 'free trial', 'sign up', 'rast', 'brzo'],
  },
  {
    id: 'modern_corporate',
    name: 'Modern Corporate',
    description:
      'Structured, trustworthy and clear. A disciplined grid, a navy or slate foundation, real workplace photography and one stat or proof point per frame. For B2B services, finance and professional firms.',
    typography: {
      headline: { family: 'sans', weight: 700, case: 'none', tracking: -0.01 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'Bold sans headline of up to 8 words, a regular-weight support line at 45% of its size, a small uppercase category label, and one stat in large figures when the content has one.',
    },
    color: {
      background: 'mixed',
      accent: 'analogous',
      logic: 'Deep brand color or navy for headline blocks, white or light-gray panels for content, and one analogous accent for emphasis. Large areas stay calm and low in saturation.',
      ink: '#101828',
      paper: '#F4F6F9',
    },
    composition: [
      'Clear split: photograph on one half, solid color panel with text on the other',
      'Text left-aligned on a visible grid with consistent margins',
      'A single stat or proof point set large beside the headline when one exists',
      'Logo and call to action sit on the bottom edge in a fixed band',
    ],
    photography: {
      subjects: [
        'Two colleagues reviewing a document at a window desk, natural pose',
        'Professional at work seen from behind or in profile',
        'Modern office architecture with clean glass and steel lines',
        'Hands on documents, a pen and a laptop in tidy arrangement',
      ],
      treatment: ['Bright even daylight, neutral to slightly cool color grade', 'Medium depth of field, subject sharp, background calm', 'Straight horizon and vertical lines, clean framing'],
      avoid: ['Posed handshakes and thumbs-up', 'Overlit empty boardrooms and fake globe graphics', 'Clip-art business icons'],
    },
    density: 'balanced',
    decorative: ['A solid color band or panel as the structure of the layout', 'Thin divider lines and a small uppercase category label', 'Square or slightly rounded corners, restrained shadows'],
    channels: ['linkedin', 'facebook', 'email', 'google_search', 'youtube', 'organic_content'],
    templateCategories: ['professional_services', 'tech_saas'],
    industries: ['consulting', 'finance', 'banking', 'insurance', 'legal', 'accounting', 'logistics', 'manufacturing', 'hr', 'real estate', 'healthcare', 'b2b services', 'engineering'],
    keywords: ['corporate', 'professional', 'b2b', 'consulting', 'enterprise', 'finance', 'bank', 'banka', 'insurance', 'legal', 'accounting', 'compliance', 'trustworthy', 'solutions', 'uslug*', 'kompanij*', 'konsalting*', 'osiguranj*', 'finans*', 'firma'],
  },
  {
    id: 'luxury_hospitality',
    name: 'Luxury Hospitality',
    description:
      'Dark, warm and unhurried. Deep ink grounds, champagne or brass accents, a refined serif headline and candlelit photography that sells an experience before a price. For hotels, fine dining, spas and venues.',
    typography: {
      headline: { family: 'serif', weight: 500, case: 'none', tracking: 0 },
      body: { family: 'sans', weight: 300 },
      hierarchy: 'Refined serif headline of 2 to 6 words, a widely tracked uppercase eyebrow with the venue or occasion, a light sans support line; weights stay light to medium, never heavy.',
    },
    color: {
      background: 'dark',
      accent: 'neutral',
      logic: 'Deep ink or espresso background, warm off-white type, and one champagne, brass or wine accent used for a thin line or a single word. Keep saturation low and contrast high.',
      ink: '#15110E',
      paper: '#F2EBE0',
    },
    composition: [
      'Centered or lower-left headline over a darkened area of the photograph',
      'Wide margins and a thin hairline frame inset from the canvas edge',
      'One hero photograph with a soft dark gradient under the text',
      'Eyebrow, headline and a single understated line, nothing more',
    ],
    photography: {
      subjects: [
        'Candlelit table with a plated dish and wine glasses at a shallow angle',
        'Hotel suite or spa interior with warm lamplight and linen texture',
        'Chef hands plating a dish in a calm kitchen, no face',
        'Empty lounge or terrace at dusk with soft ambient lights',
      ],
      treatment: ['Low-key lighting, deep shadows, warm highlights', 'Shallow depth of field with soft bokeh from practical lights', 'Rich but restrained color grade leaning amber'],
      avoid: ['Bright flat lighting and crowded tables', 'Cartoon gold effects, sparkles and glitter', 'Visible price tags and discount stickers'],
    },
    density: 'airy',
    decorative: ['Hairline frame or double rule inset from the edge', 'A small ornamental divider between eyebrow and headline, no clip art', 'Subtle warm gradient or film grain on dark fields'],
    channels: ['instagram', 'facebook', 'email', 'organic_content', 'youtube'],
    templateCategories: ['hospitality', 'editorial_brand'],
    industries: ['restaurant', 'hotel', 'fine dining', 'resort', 'spa', 'wine bar', 'cocktail bar', 'catering', 'wedding venue', 'boutique hotel', 'lounge', 'hospitality', 'villa rental'],
    keywords: ['luxur*', 'exclusive', 'fine dining', 'gourmet', 'chef', 'tasting', 'reservation', 'resort', 'hotel', 'restaurant', 'dinner', 'restoran*', 'ugostiteljstv*', 'luksuz*', 'rezervacij*', 'degustacij*', 'vecer*', 'smestaj*', 'apartman*', 'konoba'],
  },
  {
    id: 'lifestyle_photography',
    name: 'Lifestyle Photography',
    description:
      'Photo-led and human. A full-bleed natural-light photograph of a real moment carries the message; type is small, warm and sits on a soft scrim. For local businesses, food, travel and active brands.',
    typography: {
      headline: { family: 'sans', weight: 600, case: 'none', tracking: -0.01 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'Friendly semibold sans headline of 2 to 6 words over a calm part of the photo, one short support line and a small button; type never covers faces or the main subject.',
    },
    color: {
      background: 'mixed',
      accent: 'analogous',
      logic: 'The photograph supplies the palette; type is white or ink depending on the area behind it, over a soft scrim. The brand color appears only on the button and small details.',
      ink: '#1F1B18',
      paper: '#FAF6F0',
    },
    composition: [
      'Full-bleed photograph with the subject off-center on a third line',
      'Text block in the calmest area (sky, wall, table) on a soft scrim',
      'Keep faces and the main subject clear of the text area',
      'Small logo and button anchored to one lower corner',
    ],
    photography: {
      subjects: [
        'People sharing a table, hands reaching for food, faces soft or turned away',
        'Barista, baker or maker at work in a real, slightly messy workspace',
        'Friends or family outdoors in golden-hour light, candid movement',
        'Local street, market or shopfront details with everyday life',
      ],
      treatment: ['Natural available light, golden hour or open shade', 'Candid, documentary framing; slight motion is welcome', 'Warm, true-to-life color; gentle contrast; fine grain'],
      avoid: ['Posed stock smiles looking into the camera', 'Over-edited HDR look or heavy filters', 'Empty, sterile spaces without people or traces of use'],
    },
    density: 'balanced',
    decorative: ['No decoration over the photograph except a soft scrim', 'A small rounded button or a thin underline for the call to action', 'An optional thin white inset border on a few frames only'],
    channels: ['instagram', 'facebook', 'tiktok', 'organic_content', 'community', 'youtube'],
    templateCategories: ['hospitality', 'editorial_brand'],
    industries: ['restaurant', 'cafe', 'bakery', 'food', 'catering', 'travel', 'tourism', 'fitness', 'gym', 'outdoor', 'local business', 'barbershop', 'florist', 'pet care'],
    keywords: ['lifestyle', 'authentic', 'natural', 'community', 'local', 'brunch', 'coffee', 'cafe', 'bakery', 'fitness', 'travel', 'outdoor', 'kaf*', 'pekar*', 'doruc*', 'porodic*', 'putovanj*', 'teretana', 'restoran*', 'ugostiteljstv*'],
  },
  {
    id: 'clean_ecommerce',
    name: 'Clean E-commerce',
    description:
      'Bright, product-first and easy to scan. A clean background, a well-lit product, a clear price or offer badge and a single obvious button. For online shops, retail and promotions.',
    typography: {
      headline: { family: 'sans', weight: 700, case: 'none', tracking: -0.01 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'Short bold headline or product name, a price or offer figure in the largest size when the content has one, a one-line detail in regular weight, and a high-contrast button.',
    },
    color: {
      background: 'light',
      accent: 'complement',
      logic: 'White or very light paper so the product color leads; ink for text; the brand primary for the button and the offer badge; one warm accent reserved for sale signals.',
      ink: '#16181D',
      paper: '#FFFFFF',
    },
    composition: [
      'Product centered or on the right third, fully visible and uncropped',
      'Offer badge or price in a rounded shape overlapping a corner of the product',
      'Headline top left, button bottom left, a clear gap around the product',
      'Consistent margins so a series of posts reads as one catalog',
    ],
    photography: {
      subjects: [
        'Single product on a seamless light background with a soft contact shadow',
        'Product in a simple in-use scene on a table or shelf, uncluttered',
        'Flat lay of two or three related items on a pastel surface',
        'Hands holding the product against a plain wall, no face',
      ],
      treatment: ['Bright softbox lighting with accurate true-to-life color', 'Sharp focus across the whole product, clean edges', 'Plain or lightly tinted backdrop in a brand-matching hue'],
      avoid: ['Dark moody lighting that hides product detail', 'Cluttered props that hide the product', 'Invented prices, logos or discount numbers in the picture'],
    },
    density: 'dense',
    decorative: ['Rounded offer badge or sticker with strong contrast', 'Thin outline or pill shapes for tags and delivery info', 'Subtle pastel circle or block behind the product'],
    channels: ['instagram', 'facebook', 'google_search', 'email', 'tiktok'],
    templateCategories: ['ecommerce'],
    industries: ['e-commerce', 'ecommerce', 'online store', 'online shop', 'retail', 'fashion retail', 'electronics', 'cosmetics shop', 'home goods', 'grocery', 'marketplace', 'dropshipping', 'gifts'],
    keywords: ['shop', 'webshop', 'store', 'sale', 'discount', 'offer', 'deal', 'price', 'shipping', 'delivery', 'product', 'buy', 'order', 'prodavnic*', 'popust*', 'akcij*', 'ponud*', 'dostav*', 'narudzbin*', 'snizenj*'],
  },
  {
    id: 'dynamic_events',
    name: 'Dynamic Events',
    description:
      'Energetic and time-bound. Condensed display type, diagonal cuts, saturated duotone color and a clear date-and-place block that tells people when and where. For concerts, festivals, parties and tournaments.',
    typography: {
      headline: { family: 'condensed', weight: 800, case: 'upper', tracking: 0.01 },
      body: { family: 'sans', weight: 600 },
      hierarchy: 'Huge uppercase condensed headline, date and place as the second tier in bold, a slim support line and a bold ticket or register button; at most three tiers.',
    },
    color: {
      background: 'brand',
      accent: 'complement',
      logic: 'Saturated brand color or near-black field with a duotone or high-contrast photograph, white type, and one electric complementary accent for the date block and the button.',
      ink: '#0B0B12',
      paper: '#F7F5F0',
    },
    composition: [
      'Uppercase headline spanning the full width, stacked tight in two or three lines',
      'Diagonal cut or slanted band that moves the eye toward the date block',
      'Date, time and place grouped in one block in a corner or lower band',
      'Photograph cropped tight on motion, silhouettes or instruments',
    ],
    photography: {
      subjects: [
        'Crowd silhouettes against stage lights with raised hands, no identifiable faces',
        'Close crop of an instrument, microphone or turntable in motion',
        'Athlete or dancer mid-movement from a low angle with motion blur',
        'Confetti, smoke or light beams filling an empty stage',
      ],
      treatment: ['High contrast, deep blacks, saturated stage-light color', 'Duotone or color-gradient overlay in the brand colors', 'Motion blur and low angles for energy'],
      avoid: ['Real performer likenesses or recognizable crowd faces', 'Flat daylight snapshots without energy', 'Calm pastel palettes'],
    },
    density: 'dense',
    decorative: ['Slanted bars, chevrons and stripes in the accent color', 'Halftone dots or grain at low opacity over photographs', 'Outlined geometric shapes cropped by the frame edge'],
    channels: ['instagram', 'tiktok', 'facebook', 'youtube', 'email', 'community'],
    templateCategories: ['events_entertainment'],
    industries: ['events', 'concert', 'festival', 'nightlife', 'club', 'conference', 'sports', 'theatre', 'entertainment', 'tournament', 'party'],
    keywords: ['event', 'concert', 'festival*', 'party', 'ticket', 'lineup', 'live', 'dj', 'tour', 'show', 'tournament', 'dogadaj*', 'dogadjaj*', 'koncert*', 'zurk*', 'ulaznic*', 'turnir*', 'predstav*', 'nastup*', 'proslav*'],
  },
  {
    id: 'soft_lifestyle',
    name: 'Soft Lifestyle',
    description:
      'Gentle, warm and approachable. Pastel or earthy tones, rounded shapes, light humanist type and plenty of air. For wellness, beauty, family, handmade and care-focused brands.',
    typography: {
      headline: { family: 'serif', weight: 400, case: 'none', tracking: 0 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'Soft, light-weight headline of 2 to 7 words in sentence case, a friendly support line at half its size and a rounded button; avoid all caps and heavy weights.',
    },
    color: {
      background: 'light',
      accent: 'analogous',
      logic: 'Cream or blush paper, warm brown-gray ink instead of black, and two neighboring tints of the brand color; the accent is a slightly deeper tone of the primary, never neon.',
      ink: '#3A302D',
      paper: '#FBF4EC',
    },
    composition: [
      'Rounded-corner or arch-shaped photo frame on one side, text on soft color',
      'Centered stack with generous air: headline, one line, small button',
      'Overlapping organic shapes (circles, blobs) behind the subject',
      'Every element at least 8% of the canvas away from the edge',
    ],
    photography: {
      subjects: [
        'Skincare or wellness products on a linen or stone surface with a leaf shadow',
        'Hands applying cream or holding a ceramic cup, soft and unposed',
        'Parent and child hands together, faces out of frame',
        'Handmade items on a wooden table with dried flowers',
      ],
      treatment: ['Soft diffused window light, low contrast, lifted shadows', 'Pastel or earthy muted color grade with warm whites', 'Shallow depth of field with a creamy background blur'],
      avoid: ['Harsh shadows, neon colors and high-contrast looks', 'Clinical white laboratory scenes', 'Heavily retouched skin or unrealistic bodies'],
    },
    density: 'airy',
    decorative: ['Organic blobs, circles and arches in soft tints', 'A thin curved line or dotted arc accent used sparingly', 'Rounded corners everywhere; no sharp angles'],
    channels: ['instagram', 'facebook', 'organic_content', 'community', 'email', 'tiktok'],
    templateCategories: ['editorial_brand', 'ecommerce', 'hospitality'],
    industries: ['wellness', 'beauty', 'skincare', 'cosmetics', 'yoga', 'kids', 'parenting', 'handmade', 'organic food', 'therapy', 'nutrition', 'florist', 'salon', 'childcare'],
    keywords: ['soft', 'gentle', 'calm', 'wellness', 'beauty', 'skincare', 'organic', 'handmade', 'mindful', 'self care', 'yoga', 'kids', 'baby', 'salon', 'njega', 'njegu', 'lepot*', 'kozmetik*', 'zdravlj*', 'deca'],
  },
  {
    id: 'contemporary_geometric',
    name: 'Contemporary Geometric',
    description:
      'Structured and playful. Large circles, arcs, blocks and diagonals in a confident two-tone palette, clean geometric sans type and graphic rather than photographic imagery. For studios, agencies, education and tech events.',
    typography: {
      headline: { family: 'sans', weight: 700, case: 'none', tracking: -0.02 },
      body: { family: 'sans', weight: 400 },
      hierarchy: 'Heavy geometric sans headline of 2 to 6 words, a lighter support line aligned to the same edge, and a compact label or number inside a contrasting shape.',
    },
    color: {
      background: 'mixed',
      accent: 'complement',
      logic: 'Two brand colors in big flat blocks with ink or paper between them; a third accent only for a small shape or the button. Flat fills, no gradients or shadows.',
      ink: '#12141C',
      paper: '#F6F4EF',
    },
    composition: [
      'Large circle, arc or quarter-circle anchoring one corner behind the text',
      'Grid of 2 to 4 flat color blocks with the headline on the calmest one',
      'Diagonal split of the canvas with text aligned to the cut',
      'Repeated shapes at one scale for rhythm; avoid mixing many sizes',
    ],
    photography: {
      subjects: [
        'Photograph cut into a circle, arch or half-circle mask on a flat color field',
        'Cut-out object or hand with a hard shadow on a plain colored block',
        'Architectural facade with strong geometry and crisp shadows',
        'Abstract paper-cut shapes arranged on a table, shot from above',
      ],
      treatment: ['Flat even light, crisp edges, saturated flat colors', 'Duotone treatment in two brand colors', 'Top-down or straight-on camera for graphic clarity'],
      avoid: ['Busy photographic backgrounds behind the text', 'Soft gradients and glossy 3D effects', 'More than three accent hues in one frame'],
    },
    density: 'balanced',
    decorative: ['Dot grids, stripes and concentric rings in one accent color', 'Flat geometric shapes only; no drop shadows or bevels', 'Shapes may be cropped by the canvas edge'],
    channels: ['instagram', 'linkedin', 'facebook', 'youtube', 'organic_content', 'email'],
    templateCategories: ['tech_saas', 'events_entertainment', 'professional_services'],
    industries: ['design agency', 'creative studio', 'marketing agency', 'education', 'coworking', 'tech events', 'architecture', 'training', 'nonprofit', 'online course', 'consultancy'],
    keywords: ['geometric', 'pattern', 'graphic', 'modern', 'contemporary', 'creative', 'agency', 'studio', 'playful', 'colorful', 'education', 'course', 'academy', 'workshop', 'bootcamp', 'training', 'agencij*', 'kreativ*', 'kurs*', 'skol*'],
  },
];

// ---- extra per-style data used by the visual direction builder (kept here so a style is defined in one place) ------------------------------

/** Mood words (<= 40 chars each) a style evokes. */
export const STYLE_MOODS: Readonly<Record<StyleId, readonly string[]>> = {
  minimalist_tech: ['calm', 'precise', 'spacious', 'modern', 'trustworthy'],
  premium_editorial: ['refined', 'warm', 'crafted', 'quiet', 'considered'],
  bold_startup: ['energetic', 'confident', 'loud', 'fast', 'optimistic'],
  modern_corporate: ['trustworthy', 'clear', 'competent', 'structured', 'calm'],
  luxury_hospitality: ['unhurried', 'intimate', 'warm', 'exclusive', 'refined'],
  lifestyle_photography: ['authentic', 'warm', 'candid', 'welcoming', 'lived-in'],
  clean_ecommerce: ['bright', 'clear', 'friendly', 'trustworthy', 'easy to scan'],
  dynamic_events: ['energetic', 'electric', 'urgent', 'social', 'bold'],
  soft_lifestyle: ['gentle', 'warm', 'caring', 'airy', 'natural'],
  contemporary_geometric: ['playful', 'structured', 'confident', 'graphic', 'fresh'],
};

/**
 * Neutral palette used ONLY when the brand supplied no usable color: muted, style-appropriate stand-ins (never presented as the brand's own).
 */
export const STYLE_FALLBACK_COLORS: Readonly<Record<StyleId, { primary: string; secondary: string; accent: string }>> = {
  minimalist_tech: { primary: '#1E293B', secondary: '#64748B', accent: '#2563EB' },
  premium_editorial: { primary: '#2F2A26', secondary: '#8C7B6B', accent: '#9A5B3F' },
  bold_startup: { primary: '#FF5A1F', secondary: '#14181F', accent: '#1F6BFF' },
  modern_corporate: { primary: '#1E3A5F', secondary: '#4B6A8F', accent: '#2E8B9A' },
  luxury_hospitality: { primary: '#2A1F1A', secondary: '#6B5444', accent: '#B89B5E' },
  lifestyle_photography: { primary: '#3D3731', secondary: '#8A7F72', accent: '#C2693B' },
  clean_ecommerce: { primary: '#1F2937', secondary: '#6B7280', accent: '#E5393B' },
  dynamic_events: { primary: '#3B1FD1', secondary: '#0B0B12', accent: '#FF3D81' },
  soft_lifestyle: { primary: '#B98A7D', secondary: '#D9C3B0', accent: '#8C9A7B' },
  contemporary_geometric: { primary: '#2D3FE0', secondary: '#FF6B4A', accent: '#FFC53D' },
};

// ---- lookups ---------------------------------------------------------------------------------------------------------------------------------

const BY_ID: ReadonlyMap<StyleId, StyleDef> = new Map(STYLES.map((s) => [s.id, s]));

export const isStyleId = (x: unknown): x is StyleId => typeof x === 'string' && (STYLE_IDS as readonly string[]).includes(x);

/** The style with this id. Throws only for an id that is not one of STYLE_IDS (a programming error, never user input: check with isStyleId). */
export function getStyle(id: StyleId): StyleDef {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`Unknown style id: ${String(id)}`);
  return s;
}

/** All ten styles in the canonical STYLE_IDS order (a fresh array). */
export function listStyles(): StyleDef[] {
  return STYLE_IDS.map((id) => getStyle(id));
}

// ---- deterministic matching ---------------------------------------------------------------------------------------------------------------

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'd', е: 'e', ж: 'z', з: 'z', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's',
};

/** Lower-case and accent-insensitive: č ć š ž and đ fold to c c s z d, Serbian Cyrillic is transliterated. ("dj" is NOT folded: list "dogadjaj" next to "događaj".) */
export function foldForMatch(word: string): string {
  const lower = word.toLowerCase();
  let out = '';
  for (const ch of lower) out += CYRILLIC[ch] ?? ch;
  return out
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/ł/g, 'l');
}

interface Token {
  raw: string;
  norm: string;
}
const tokenize = (s: string): Token[] => [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ raw: m[0].toLowerCase(), norm: foldForMatch(m[0]) }));

interface Part {
  w: string;
  prefix: boolean;
}
const compileKeyword = (kw: string): Part[] =>
  kw
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => {
      const prefix = p.endsWith('*');
      return { w: foldForMatch(prefix ? p.slice(0, -1) : p), prefix };
    });

function partMatches(p: Part, tok: string): boolean {
  if (p.prefix) return tok.startsWith(p.w);
  return tok === p.w || tok === `${p.w}s` || tok === `${p.w}es` || (p.w.endsWith('y') && tok === `${p.w.slice(0, -1)}ies`);
}

/** The words of `tokens` (as the user wrote them) that match this compiled keyword, or null. */
function findKeyword(tokens: readonly Token[], parts: readonly Part[]): string | null {
  if (!parts.length) return null;
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    if (parts.every((p, j) => partMatches(p, tokens[i + j]!.norm))) return tokens.slice(i, i + parts.length).map((t) => t.raw).join(' ');
  }
  return null;
}

interface CompiledStyle {
  keywords: { kw: string; parts: Part[] }[];
  industries: { kw: string; parts: Part[] }[];
}
const COMPILED = new Map<StyleId, CompiledStyle>();
function compiled(style: StyleDef): CompiledStyle {
  let c = COMPILED.get(style.id);
  if (!c) {
    c = { keywords: style.keywords.map((kw) => ({ kw, parts: compileKeyword(kw) })), industries: style.industries.map((kw) => ({ kw, parts: compileKeyword(kw) })) };
    COMPILED.set(style.id, c);
  }
  return c;
}

export interface StyleMatchContext {
  industry?: string;
  /** Product summary, business name, design direction ... any free text. */
  text?: string;
  audience?: string;
  tone?: string;
  objective?: string;
  channels?: ChannelId[];
  categoryHint?: TemplateCategory;
}

export interface StyleMatch {
  style: StyleDef;
  score: number;
  reasons: string[];
}
export interface StyleMatchDetailed extends StyleMatch {
  /** The part of the score that comes from the words of the brief (industry, text, audience, tone, objective): 0 = nothing in the brief pointed to this style. */
  contentScore: number;
}

/** Weights: what a word found in each field is worth, per list. The industry field is the strongest signal. */
const W = {
  industry: { industries: 5, keywords: 3 },
  text: { industries: 2.5, keywords: 2 },
  tone: { industries: 1, keywords: 2 },
  audience: { industries: 1, keywords: 1.5 },
  objective: { industries: 1, keywords: 1.5 },
} as const;
type Field = keyof typeof W;
const DECAY = 0.85;
const CHANNEL_WEIGHT = 0.4;
const CHANNEL_CAP = 1.2;
const CATEGORY_WEIGHT = 3;
const round = (n: number) => Math.round(n * 1000) / 1000;

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  tech_saas: 'tech and SaaS',
  hospitality: 'hospitality',
  ecommerce: 'e-commerce',
  professional_services: 'professional services',
  editorial_brand: 'editorial brand',
  events_entertainment: 'events and entertainment',
};

/**
 * Ranks ALL ten styles for a brief. Deterministic: same context => same order, ties broken by style id. Each distinct keyword or industry
 * term counts once (its best field), with a decay so a long text that repeats one theme cannot drown the rest. Works for English and
 * Serbian/Croatian (accent-insensitive; Cyrillic is transliterated).
 */
export function matchStylesDetailed(ctx: StyleMatchContext): StyleMatchDetailed[] {
  const fields: { field: Field; tokens: Token[] }[] = (['industry', 'text', 'tone', 'audience', 'objective'] as const)
    .map((field) => ({ field, tokens: tokenize(String(ctx[field] ?? '')) }))
    .filter((f) => f.tokens.length > 0);
  const channels = [...new Set(ctx.channels ?? [])];

  const results = STYLES.map((style): StyleMatchDetailed => {
    const c = compiled(style);
    interface Hit {
      weight: number;
      word: string;
      list: 'industries' | 'keywords';
    }
    const hits = new Map<string, Hit>();
    const consider = (list: 'industries' | 'keywords', terms: CompiledStyle['keywords']) => {
      for (const t of terms) {
        for (const f of fields) {
          const word = findKeyword(f.tokens, t.parts);
          if (!word) continue;
          const weight = W[f.field][list];
          const key = `${list}:${t.kw}`;
          const prev = hits.get(key);
          if (!prev || weight > prev.weight) hits.set(key, { weight, word, list });
        }
      }
    };
    consider('industries', c.industries);
    consider('keywords', c.keywords);

    const ordered = [...hits.values()].sort((a, b) => b.weight - a.weight || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    let content = 0;
    ordered.forEach((h, i) => (content += h.weight * DECAY ** i));

    const matchedChannels = channels.filter((ch) => style.channels.includes(ch));
    const channelScore = Math.min(CHANNEL_CAP, matchedChannels.length * CHANNEL_WEIGHT);
    const categoryHit = ctx.categoryHint ? style.templateCategories.includes(ctx.categoryHint) : false;

    const reasons: string[] = [];
    const uniq = (list: 'industries' | 'keywords') => [...new Set(ordered.filter((h) => h.list === list).map((h) => h.word))].slice(0, 4);
    const ind = uniq('industries');
    const kw = uniq('keywords').filter((w) => !ind.includes(w));
    if (ind.length) reasons.push(`Typical for this kind of business: ${ind.join(', ')}`);
    if (kw.length) reasons.push(`The brief mentions ${kw.map((w) => `"${w}"`).join(', ')}, which this style is built for`);
    if (categoryHit && ctx.categoryHint) reasons.push(`Fits the ${CATEGORY_LABEL[ctx.categoryHint]} template group`);
    if (matchedChannels.length) reasons.push(`Works well on ${matchedChannels.join(', ').replace(/_/g, ' ')}`);
    if (!reasons.length) reasons.push('No word, industry, channel or category of the brief points to this style');

    return { style, score: round(content + channelScore + (categoryHit ? CATEGORY_WEIGHT : 0)), contentScore: round(content), reasons };
  });

  return results.sort((a, b) => b.score - a.score || (a.style.id < b.style.id ? -1 : a.style.id > b.style.id ? 1 : 0));
}

/** All ten styles, best match first, with human-readable reasons. Pure and deterministic. */
export function matchStyles(ctx: StyleMatchContext): StyleMatch[] {
  return matchStylesDetailed(ctx).map(({ style, score, reasons }) => ({ style, score, reasons }));
}
