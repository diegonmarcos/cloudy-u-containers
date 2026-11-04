import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pdftext  # noqa: E402

def _pdf(text: bytes) -> bytes:
    """A one-page PDF drawing [text], with a correct xref table."""
    stream = b"BT /F1 12 Tf 20 50 Td (" + text + b") Tj ET"
    objs = [b"<</Type/Catalog/Pages 2 0 R>>", b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
            b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream",
            b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    return out + b"trailer<</Root 1 0 R/Size %d>>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)


PDF = _pdf(b"Hello fleet")


class PdfText(unittest.TestCase):
    def test_extracts_text(self):
        r = pdftext.extract(PDF)
        self.assertEqual(r["pages"], 1)
        self.assertIn("Hello fleet", r["text"])
        self.assertFalse(r["truncated"])

    def test_rejects_non_pdf_and_empty(self):
        for bad in (b"", b"hello world"):
            with self.assertRaises(ValueError):
                pdftext.extract(bad)

    def test_rejects_oversized(self):
        with self.assertRaises(ValueError):
            pdftext.extract(b"%PDF" + b"0" * pdftext.MAX_BYTES)

    def test_damaged_pdf_is_a_value_error(self):
        with self.assertRaises(ValueError):
            pdftext.extract(b"%PDF-1.4\nnot really")


if __name__ == "__main__":
    unittest.main()
