"""Copy the tested canonical POS domain to the Supabase Edge Function bundle."""
from pathlib import Path
import shutil
root = Path(__file__).resolve().parent
dest = root.parent / 'supabase/functions/pub-bizz-pos'
dest.mkdir(parents=True, exist_ok=True)
for name in ('catalog.js', 'core.js', 'server-domain.js'):
    shutil.copyfile(root / name, dest / name)
print('Edge domain synchronized')
