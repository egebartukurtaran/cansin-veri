"""Checks the output of the 'fill a cell and add a row' test with pyreadstat.

Usage: python scripts/verify_sav.py fixtures/_test_output.sav <DosyaNo of the edited row>
Needs: pip install pyreadstat pandas
"""
import math
import sys

import pyreadstat

ORIGINAL = "fixtures/liste.sav"


def main(path: str, file_no: str) -> None:
    orig, _ = pyreadstat.read_sav(ORIGINAL)
    df, meta = pyreadstat.read_sav(path)

    assert meta.file_encoding.lower() in ("windows-1254", "cp1254"), meta.file_encoding
    assert list(df.columns) == list(orig.columns), "column list changed"
    assert len(df) == len(orig) + 1, f"expected {len(orig) + 1} rows, got {len(df)}"

    # Untouched rows are identical.
    changed = orig.index[orig["DosyaNo"] == file_no][0]
    for i in range(len(orig)):
        for c in orig.columns:
            a, b = orig.at[i, c], df.at[i, c]
            if i == changed and c in ("Hb", "Lökosit"):
                continue
            same = (isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b)) or a == b
            assert same, f"row {i} column {c}: {a!r} != {b!r}"

    assert df.at[changed, "Hb"] == 12.6
    assert df.at[changed, "Lökosit"] == 5410

    new = df.iloc[-1]
    assert new["Adsoyad"] == "ŞÜKRÜ IŞIK ĞÜLİZAR", new["Adsoyad"]
    assert new["DosyaNo"] == "9999999"
    assert new["Kre"] == 1.24
    assert new["Yaş"] == 70
    assert math.isnan(new["Ferritin"])

    # Value labels survive.
    assert meta.variable_value_labels == pyreadstat.read_sav(ORIGINAL, metadataonly=True)[1].variable_value_labels
    print("verify_sav: OK")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
