# Crushify — landing page prototype

A responsive, static landing page for the Crushify digital love-gift concept.

## Run locally

Open `index.html` in a browser. For a local server, run:

```bash
python -m http.server 5500
```

Then open `http://localhost:5500`.

## Deploy to Vercel

1. Create a GitHub repository and upload the contents of this folder.
2. Import the repository in Vercel.
3. Framework preset: **Other**.
4. Build command: leave empty.
5. Output directory: `.`
6. Deploy.

## Current scope

- Responsive landing page and navigation.
- Canvas-based 3D particle heart with automatic rotation and pointer parallax.
- Template category filters and preview modal.
- Our Universe V4 as a standalone Canvas 2D module at `templates/our-universe/`.
- Local live preview and draft persistence in the browser for Our Universe.
- How-it-works, pricing, and CTA sections.

## Not connected yet

Our Universe drafts are stored only in the browser, and selected images are previewed locally; images are not uploaded or saved with the draft. User accounts, a database, server-side uploads, checkout, payment processing, and publishing/share links are not implemented. The displayed prices are placeholders for validation and should be confirmed before launch.
