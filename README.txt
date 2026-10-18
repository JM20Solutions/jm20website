MAIN WEBSITE UPDATE (repo: JM20Solutions/jm20website)

Copy ALL .html files in this folder into the repo ROOT, next to the current index.html
(index.html replaces the old one; the 4 legal pages are new).

Resulting public addresses (extensionless on Cloudflare Pages / GitHub Pages):
  https://jm20aisolutions.com/politica-de-privacidad     (ES)
  https://jm20aisolutions.com/terminos-de-servicio       (ES)
  https://jm20aisolutions.com/privacy-policy             (EN)
  https://jm20aisolutions.com/terms-of-service           (EN)

index.html changes (4 spots, see index.html.changes.diff):
  1. Footer "Términos de servicio" / "Política de privacidad" now link to the pages above (ES/EN aware).
  2. Cookie banner "Política de privacidad" button opens the real page.
  3. Cookie banner Accept button colour #2997ff -> #0066cc (white text was 3.0:1, WCAG AA needs 4.5:1).
  4. Scrollbar: the old 4px / 12%-white one was practically invisible; now a normal-width, visible one.

Also: add the entries in sitemap-legal-snippet.xml to the main site's sitemap.xml (if it has one).
The 4 legal pages use the same layout as eu-ai-act / ley-de-ia-ue (header bar, 720px column, footer),
without the sales CTA button, and keep the site's cookie-consent logic (Google Analytics only after Accept).
Legal text is copied character-for-character from the previous in-page version. Nothing was edited or translated.

ORDER MATTERS: publish this update BEFORE deploying Noah, because Noah's footer links to these addresses.

Legal pages: when a visitor arrives from Noah, 'Back' becomes 'Volver a Noah' / 'Back to Noah' and returns to
https://noah.jm20aisolutions.com/ (remembered for that browser tab via sessionStorage; cleared if they arrive from anywhere else).
