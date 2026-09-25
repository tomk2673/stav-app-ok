"""Build a dependency-free emergency HTML copy from exactly the deployed sources."""
from pathlib import Path
import base64

root = Path(__file__).resolve().parent
html = (root / 'index.html').read_text()
html = html.replace('<html lang="cs">', '<html lang="cs" data-standalone="true">')
html = html.replace('<link rel="manifest" href="./manifest.webmanifest">', '')
html = html.replace('href="./icon.svg"', 'href="data:image/svg+xml;base64,' + base64.b64encode((root / 'icon.svg').read_bytes()).decode() + '"')
html = html.replace('<link rel="stylesheet" href="./style.css">', '<style>' + (root / 'style.css').read_text() + '</style>')
html = html.replace('href="./" aria-label="PUB-BIZZ pokladna"', 'href="#" aria-label="PUB-BIZZ pokladna"')
scripts = []
for filename in ['catalog.js', 'core.js', 'storage.js', 'app.js']:
    html = html.replace('<script src="./' + filename + '" defer></script>', '')
    scripts.append((root / filename).read_text().replace('</script', '<\\/script'))
html = html.replace('</body>', '<script>' + '\n'.join(scripts) + '</script></body>')
(root / 'PUB-BIZZ-pokladna-offline.html').write_text(html)
print('Standalone created:', len(html.encode()), 'bytes')
