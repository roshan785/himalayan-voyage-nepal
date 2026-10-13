# Himalayan Voyage Nepal — Travel Agency Website

A complete travel-agency website with a public marketing front-end and a
JWT-protected admin CMS. **Modelled on the structure of a typical Nepali travel
agency site** (home, about, gallery, services, packages, destinations, visa,
blogs, FAQ, contact) but with **100% original code, copy and artwork**. No text,
images, logo or markup were copied from any third party.

## Travel assistant chat (local AI)

Every page has a floating **Travel Assistant** button. It is backed by a
**local Ollama model — `qwen2.5:7b`** running entirely on this machine, so it
costs nothing and works offline.

| Piece | File |
| --- | --- |
| Backend (Ollama client + grounding) | `src/chat.js` |
| Routes `GET /api/chat/status`, `POST /api/chat` | `src/routes.js` |
| Widget (injected on every page) | `public/js/chat-widget.js` |

How it stays accurate with a small model: instead of giving the model 185 tools
(which a 7B model cannot handle), the server passes a **compact snapshot of the
real database** — package names, prices, durations; destinations; visa list —
and instructs the model to answer only from that snapshot. Verified: it returns
the correct DB prices and refuses questions it cannot answer.

```bash
ollama pull qwen2.5:7b       # one-time (4.7 GB)
ollama serve                 # must be running
npm start
curl localhost:3400/api/chat/status   # {"ok":true,"model":"qwen2.5:7b",...}
```

Environment overrides: `OLLAMA_HOST`, `CHAT_MODEL`, `CHAT_TIMEOUT_MS`.

## Pages

| Page | URL | Notes |
| --- | --- | --- |
| Home | `/` | Hero, stats, packages, destinations, services, testimonials, downloads, blog |
| About | `/about.html` | Story, values, team preview, CEO message |
| Team | `/team.html` | Full team grid with photos |
| CEO message | `/ceo.html` | Leadership letter |
| Gallery | `/gallery.html` | Tile grid + lightbox |
| Services | `/services.html` | Service catalogue |
| Packages | `/packages.html` | Tabs, search, detail view |
| Destinations | `/destinations.html` | Nepal / international filter |
| Visa overview | `/visa.html` | 12-country grid |
| **Visa (per country)** | `/visa-usa.html`, `/visa-uk.html`, … | 12 dedicated pages, each with its own checklist, steps, FAQ and PDF |
| Blogs | `/blogs.html` · `/posts.html` | Listing + single article |
| Documents | `/documents.html` | All 21 PDFs |
| FAQ | `/faq.html` | Accordion |
| Contact | `/contact.html` | Form + details |
| Admin | `/admin.html` | JWT-protected console |
| 404 | any unknown path | Real 404, not a catch-all |

## Downloads (documents)

The site offers **21 generated PDF documents**:

| Type | Count | Example |
| --- | --- | --- |
| Tour itineraries | 8 | `docs/pokhara-leisure-tour.pdf` |
| Visa document checklists | 12 | `docs/visa-japan.pdf` |
| Company profile / brochure | 1 | `docs/company-profile.pdf` |

```bash
npm run docs      # regenerate all PDFs from the database
```

They are produced by `scripts/generate-docs.js` using **pdfkit**, straight from
the same database the website reads — so a price or itinerary change in the
admin console can never leave the PDFs out of date. `public/docs/index.json`
lists every document and drives the *Documents* page and the homepage download
cards. Every package detail page also links its own itinerary PDF.

## Photography

Destination and package covers use **real photographs of the actual places**
(48 images: Pokhara, Rara Lake, Mustang, Chitwan, Everest, Kathmandu Durbar,
Boudhanath, Pashupatinath, Patan, Bhaktapur, Lumbini, Sarangkot, Langtang,
London, Paris, Barcelona, Rome, Tokyo, Bangkok, Dubai, Singapore, Sydney,
New York, Stonehenge, Bali, and more).

These images are pulled automatically from **Wikimedia Commons**, where every
file carries an explicit licence (CC BY / CC BY-SA / Public Domain) and a named
author. The loader records the attribution in
`public/images/credits.json`, and the site renders the credit next to each
photo plus a **"Photo credits & licences"** list in the footer — which is what
those licences require. Nothing is used without credit.

```bash
node scripts/fetch-images.js          # download any missing images
node scripts/fetch-images.js --force  # re-download everything
```

Each record maps to its photo via the `image` field, its `slug`, or a
keyword match — so a package called "Pokhara Leisure Tour" automatically picks
up `images/pokhara.jpg`. When no photo matches, the card falls back to original
CSS/SVG artwork, so the layout never breaks.

> To use your own photography instead, drop files into `public/images/` using
> the same slugs (e.g. `pokhara.jpg`) and re-run `node scripts/fetch-images.js`
> — or just set the `image` field on a record through the admin console.

---

## Features

**Public site**
- Home, About, Gallery (with lightbox), Services, Packages, Destinations, Visa, Blogs, single article, FAQ (accordion), Contact.
- Tour packages with category tabs, live search and a per-package detail view.
- Destinations filtered by Nepal / international, each linking to related packages.
- Contact form and newsletter sign-up (validated, rate-limited).
- Fully responsive, mobile navigation, scroll-reveal animations, accessible markup.

**Admin console** (`/admin.html`) — requires login
- Overview dashboard with live counts and recent enquiries.
- Full CRUD for packages, destinations, blog posts and testimonials.
- Enquiry inbox (mark handled / reopen / delete) and subscriber list.
- JWT auth with HttpOnly cookie + Bearer token.

**API**
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | – | Health check |
| GET | `/api/site` | – | Site/contact configuration |
| GET | `/api/stats` | – | Content counts |
| GET | `/api/packages` | – | List (`?category=`, `?featured=1`, `?q=`) |
| GET | `/api/packages/:slug` | – | One package |
| GET | `/api/destinations` | – | List (`?kind=nepal|international`) |
| GET | `/api/destinations/:slug` | – | One destination |
| GET | `/api/testimonials` | – | List |
| GET | `/api/posts` · `/api/posts/:slug` | – | Blog list / one post |
| POST | `/api/contact` | – | Submit enquiry |
| POST | `/api/newsletter` | – | Subscribe |
| POST | `/api/auth/login` · `/logout` | – | Session |
| GET | `/api/auth/me` | ✅ | Current user |
| — | `/api/admin/*` | ✅ | Overview, CRUD, contacts, subscribers |

---

## Requirements

- **Node.js 20+** (the project uses the built-in `node:sqlite` module, stable in
  Node 22). No native build tools required.

## Setup

```bash
cd apps/travel-nepal
npm install
cp .env.example .env        # then edit JWT_SECRET
npm run seed                # creates the DB, seed content and an admin user
npm start
```

Open <http://localhost:3400> for the site and
<http://localhost:3400/admin.html> for the console.

Default development admin (change before deploying):

```
email:    admin@himalayanvoyage.test
password: admin12345
```

## Configuration (`.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3400` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `JWT_SECRET` | dev fallback | **Must** be set in production |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime |
| `DB_PATH` | `./data/travel.db` | SQLite file |
| `ADMIN_EMAIL` | `admin@himalayanvoyage.test` | Seeded admin |
| `ADMIN_PASSWORD` | `admin12345` | Seeded admin password |

## Tests

```bash
npm test
```

Boots the app on an ephemeral port against a throwaway database and runs **28
integration tests** covering the public API, validation/edge cases, auth
(wrong password, missing token, tampered token) and admin CRUD. Test
credentials are generated at runtime, so no secrets live in the repo.

## Project layout

```
travel-nepal/
├── server.js               Express app (static + API + security headers + rate limit)
├── seed.js                 Idempotent DB seed + admin creation
├── test.js                 Integration test suite
├── src/
│   ├── db.js               node:sqlite schema, helpers, seed data
│   ├── auth.js             bcrypt hashing, JWT issue/verify, requireAuth middleware
│   └── routes.js           Public + admin routers, validation, slug generation
├── scripts/
│   └── fetch-images.js     Downloads freely-licensed photos + credits.json
└── public/
    ├── *.html              One file per page
    ├── css/style.css       Design system
    ├── images/             Destination photos + credits.json (attribution)
    └── js/                 layout, main helpers, and one script per page
```

## Security notes

- Passwords hashed with bcrypt (cost 10); JWTs signed with `JWT_SECRET`.
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy` set on every response.
- In-memory rate limit (40 req/min/IP) on `/api/contact`, `/api/newsletter` and
  `/api/auth/login`.
- All SQL uses parameterised statements — no string concatenation.
- Admin writes are confined to whitelisted columns via per-resource normalisers.
- Error responses never leak stack traces.

## Deployment

1. Set a strong `JWT_SECRET` and change the admin password.
2. Run behind a TLS-terminating reverse proxy (nginx/Caddy).
3. Back up `data/travel.db` (WAL mode) regularly.
4. Use a process manager (systemd, PM2) with `npm start`.

## License

Original work. Provided as-is for demonstration and as a starting point for a
real agency site.

## Production database (PostgreSQL)

Set `DATABASE_URL` and the app switches from SQLite to PostgreSQL automatically —
no code change. Verify with:

```bash
curl -s /api/health   # -> {"db":"postgres","dbPersistent":true}
```

Cutover, verification and secret-rotation steps: see
[DATABASE-MIGRATION.md](DATABASE-MIGRATION.md).

> The test suite refuses to run against a database whose name does not contain
> `test`/`ci`/`sandbox` — it deletes and re-creates data, so production is safe.
