`fictional-invoice.heic` and `fictional-invoice.jpg` contain a synthetic white
640 × 800 page labelled FICTIONAL INVOICE - TEST ONLY. They have no real supplier,
customer, account or payment data. Generated with Pillow and `pillow-heif==1.1.1`:

```python
from PIL import Image, ImageDraw
import pillow_heif
pillow_heif.register_heif_opener()
img = Image.new("RGB", (640, 800), "white")
draw = ImageDraw.Draw(img)
draw.text((40, 40), "FICTIONAL INVOICE - TEST ONLY", fill="black")
draw.text((40, 100), "TEST-001 / 1 item / 100 CZK / VAT 21% / 121 CZK", fill="black")
img.save("fictional-invoice.heic", quality=95)
img.save("fictional-invoice.jpg", quality=95)
```

The browser test executes the real HEIC decoder, image/crop pipeline, invoice
parser and capture queue SQL. The OCR engine response is deliberately simulated
with fictional line data; it does not measure accuracy of real invoice OCR.
