# traza — the metro map of your agent sessions

Source: https://traza-sand.vercel.app

To create a video from this capture, use the `product-launch-video` skill.

## What's in This Capture

| File | Contents |
|------|----------|
| `screenshots/contact-sheet.jpg` | **View this first.** All scroll screenshots in labeled grid — see the entire page at a glance |
| `screenshots/scroll-*.png` | Individual viewport screenshots if you need detail on a specific section. |
| `extracted/tokens.json` | Design tokens: 13 colors, 4 fonts, 1 headings, 0 CTAs |
| `extracted/design-styles.json` | Computed styles from live DOM: typography hierarchy, button/card/nav styles, spacing scale, border-radius, box shadows. Primary data source for DESIGN.md. |
| `extracted/asset-descriptions.md` | One-line description of every downloaded asset. Read this for asset selection — only open individual files for safe-zone checking. |
| `extracted/visible-text.txt` | Page text in DOM order, prefixed with HTML tag (`[h1]`, `[p]`, `[a]`). Use as context — rephrase freely. |
| `assets/contact-sheet.jpg` | All downloaded images in one labeled grid. |
| `assets/svgs/contact-sheet.jpg` | SVGs rendered as thumbnails in labeled grid |
| `assets/` | Individual downloaded images, SVGs, and font files. |

## Brand Summary

- **Colors**: #EDF0F5 (bg-light), #1C2733 (accent), #5A6B80 (neutral), #FBFCFE (bg-light), #101E32 (accent), #D5DCE6 (surface-light), #0F4E9E (accent), #FFFFFF (bg-light), #7F96B8 (neutral), #0E141D (accent)
- **Fonts**: Fira Sans (400,500,600,700), Fira Sans Condensed (500,600,700), Fira Sans Extra Condensed (600,700), Fira Code (400,500,700)
