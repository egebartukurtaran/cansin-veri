# SPEC — Lab/Eko PDF → SPSS (.sav) Aktarım Uygulaması

## 1. Amaç
Gazi Üniversitesi hastanesinin laboratuvar ve ekokardiyografi PDF raporlarından değerleri okuyup mevcut SPSS `.sav` araştırma listesine yazan, **Windows + Chrome** üzerinde çalışan, kurulum gerektirmeyen bir PWA. Kullanıcı yazılımcı değil (hekim). Uygulama sürekli kullanılacak.

**Altın kural:** Emin olunamayan hiçbir değer yazılmaz. Bulunamayan değer **boş** kalır.

## 2. Stack
- Vite + TypeScript (vanilla veya React, tercih geliştiricinin)
- `pdfjs-dist` — PDF metin + koordinat çıkarımı
- `vite-plugin-pwa` — offline + "Yükle" desteği
- `.sav` okuma/yazma: **kendi TS modülümüz** (bkz. §6), harici kütüphane yok
- Vitest — birim testleri
- Deploy: GitHub Pages, GitHub Actions ile her push'ta
- Tüm işlem tarayıcıda. **Hiçbir veri sunucuya gönderilmez.** Analytics, telemetri, harici font/CDN yok.

## 3. Kullanıcı akışı
1. **Liste seç:** `.sav` dosyasını `showOpenFilePicker` ile seçer. FileSystemHandle IndexedDB'de saklanır; sonraki açılışta "Son kullanılan: X.sav — devam et" gösterilir (Chrome izin sorar).
2. **PDF ekle:** Birden fazla PDF sürükle-bırak / seç. Farklı hastalara ait PDF'ler karışık olabilir.
3. **Önizleme:** Hasta bazında gruplanmış değişiklik tablosu (bkz. §7). Kullanıcı kontrol eder.
4. **Kaydet:** `showSaveFilePicker`, önerilen ad: `<orijinal_ad>_YYYY-MM-DD_HHmm.sav`. **Orijinal dosyanın üzerine asla yazılmaz.**
5. Kaydettikten sonra yeni dosya "son kullanılan liste" olur.

UI dili Türkçe. Büyük, net butonlar. Teknik terim yok.

## 4. PDF türleri ve tanıma
Tüm PDF'lerde hasta, **Protokol / Dosya No** ile tanımlanır → `.sav`'daki `DosyaNo` (string) ile eşleşir. İsimle eşleştirme yapılmaz (listede küçük harfli isimler var).

### 4.1 Laboratuvar raporu
Tanıma: başlıkta `TIBBİ LABORATUVAR TETKİK SONUÇ RAPORU`.

Başlık alanları:
| Alan | PDF'te | Örnek |
|---|---|---|
| Ad Soyad | `Hastanın Adı, Soyadı :` | `AD SOYAD` |
| Doğum tarihi + cinsiyet | `Doğum Tarihi, Cinsiyeti :` | `GG/AA/YYYY / K` |
| Dosya No | `Protokol / Dosya / İşlem No:` | `1234567` |
| **Numune Alma Zamanı** | Etiketin altındaki satır, aynı kolon | `GG/AA/YYYY SS:DD` |

- Numune Alma Zamanı, rapordaki "tarih" olarak kullanılır (en güncel seçimi + yaş hesabı). Başlıkta 4 tarih var (İstek, Kabul / Alma, Onay); doğru olanı **koordinata göre** al, sıraya güvenme.
- Çok sayfalı raporlarda (örn. 2/2) başlık her sayfada tekrarlanır; testler tüm sayfalardan okunur.

Test satırları: `Test Adı | Sonuç | Durum (Y/D) | Birim | Referans | Önceki Sonuçlar`
- **Sadece "Sonuç" kolonu alınır.** "Önceki Sonuçlar" kolonları ve altlarındaki `(11/08/26)` tarihleri yok sayılır. Kolonları `pdf.js` text item `transform[4]` (x) değerlerine ve başlık satırındaki kolon başlıklarının x konumuna göre ayır.
- Sayılar Türkçe formatta: `4,95` → `4.95`, `1492` → `1492`.
- Sonuç `<` veya `>` ile başlıyorsa (örn. `< 0,5`): **yazma**, önizlemede uyarı göster.
- Satırın altında `Bu test hemolizden etkilenmiştir.` varsa: değeri yaz ama önizlemede uyarı göster.
- Test adı eşleştirmesi **tam eşleşme** (trim + boşluk normalize). Kısmi eşleşme YOK — `Kreatinin (Spot İdrar)` ≠ `Kreatinin`, `Kolesterol, Non-HDL` ≠ `Kolesterol, HDL`.

### 4.2 Eko raporu
Tanıma: başlıkta `Kardiyoloji Sonuç Raporu` + `Transtorasik ekokardiyografi`.

Başlık: `Hastanın Adı Soyadı`, `Protokol Numarası` (→ DosyaNo), `Cinsiyet` (`Kadın`/`Erkek`), `Doğum Tarihi`, **`Çekim Tarihi`** (rapor tarihi).

Değerler iki yerden okunur:
- **Bulgular tablosu:** Her satırda `Parametre | NORMAL aralık | BULGU`. Sağ yarıda ikinci bir tablo (MİTRAL/TRİKÜSPİT) var. Değer **BULGU kolonundan** alınır, normal aralıktan değil (`SOL ATRİYUM 1,9 - 4,0 cm 3,5` → `3.5`). x koordinatına göre kolon ayır.
- **Sonuç metni** (2. sayfa, `Sonuç` başlığı altındaki serbest metin): regex ile.

### 4.3 Tanınmayan PDF
Ne lab ne eko ise: önizlemede "Tanınmadı: <dosya adı>" uyarısı, hiçbir şey yazılmaz.

### 4.4 Word (.docx) notları
PDF'lerden elle derlenmiş hasta notları. Bir dosyada bir veya birden fazla hasta olabilir. `.doc` (eski biçim) desteklenmez; kullanıcıya `.docx` olarak kaydetmesi söylenir.

Hasta bloğu: **ad soyad satırı**, hemen altında `Dosya No: ...` veya `Yaş: ...` satırı (yeni hasta bloğu böyle başlar). Tarih yoktur.

| Satır | Kolon | Kural |
|---|---|---|
| `Dosya No: 1234567` | eşleştirme | İsteğe bağlı. Yoksa hasta **listedeki isimle** (büyük/küçük harf duyarsız) eşleştirilir; isim listede tek değilse veya yoksa hiçbir şey yazılmaz. Dosya No'suz yeni hasta eklenmez. |
| `Yaş: 60`, `Yaş - 60`, `60 yaşında`, `60 yaşında kadın hasta`, `60/K`, `Kadın, 60` | `Yaş`, `CinsiyetK1E2` | Yaş doğrudan; kadın/bayan/K → 1, erkek/bay/E → 2. Ad satırında da olabilir: `AD SOYAD, 60, K` / `AD SOYAD (60 yaş kadın)`. Aynı notta hem kadın hem erkek varsa yazılmaz. |
| `<Test Adı> - <değer> <birim>` | §5.2 | Test adı PDF'lerle aynı, **tam eşleşme**; `<`/`>` yazılmaz |
| `Ef: 60` | `EFyüzde` | |
| `Kapak patolojisi yok` / `var: eser MY` | `Kapak_patolojisi`, `Kapak_patolojisi_tipi` | yok → 0 ve tipi `"0"`; var → 1 ve tipi = açıklama |
| `e/a 1den büyük` / `küçük` | `e_a` | 1 / 0 |
| `... hipertrofi yok/var` | `Sol_ventrikül_hipertrofisi` | 0 / 1; belirsizse yazılmaz |
| `diyastolik disfonksiyon yok/var` | `Diyastolik_disfonksiyon` | 0 / 1 |
| `sol atrium 3,3` | `Sol_atriyum_çapı` | |
| `TAPSE`, `PAB`, `VCI` + sayı; `%50'den fazla/az kollabe` | eko kolonları | §5.3 ile aynı |
| `kbh süresi: 7` | `KBHsüresi` | |
| `Komorbidite: HT, DM`, `KOMORBİDİTE - HT` (tablo), `Ek hastalıklar:`, `Özgeçmiş:`, ya da `Komorbidite:` altında `- HT` / `- DM` madde listesi; `yok` → hepsi 0 | `Komorbidite` (metin) + `DMYok0Var1`, `HTYok0Var1`, `KAHYok0Var1`, `KOAHYok0Var1`, `SVOYok0Var1` | geçen → 1, geçmeyen → 0 |
| `Ofis Ta: 145 (skb) /85 (dkb)` | `SKBmmHg`, `DKBmmHg` | |
| `PTÖ: -` / `+` | `pretibial_odem` | 0 / 1 |
| `<Listedeki kolon adı>: <değer>` | o kolon | Genel kural: herhangi bir liste kolonu bu şekilde eklenebilir (örn. `Boy: 162`) |

Anlaşılamayan satırlar önizlemede listelenir, hiçbir şey yazılmaz. Büyük harf ve Türkçe `İ` ile yazılmış satırlar da tanınır. Metin kolonlarında büyük/küçük harf farkı (`ht, dm` / `HT, DM`) çakışma sayılmaz.

**Word önceliklidir** (elle kontrol edilmiş kaynak): Word'deki okunabilir değer PDF'lerdeki değere ve listedeki dolu değere göre esas alınır. Listedeki dolu ve farklı bir değerin üzerine yazılacaksa önizlemede "🔁 Üzerine yazılacak" satırı olarak, **varsayılan işaretli** bir kutuyla gösterilir; işaret kaldırılırsa listedeki değer korunur ("Hepsini işaretle" / "Hiçbirini değiştirme" butonları var). İki Word dosyası aynı kolona farklı değer verirse çakışma olur, yazılmaz. Sadece PDF kaynaklı çakışmalarda kural değişmedi (§6): üzerine yazılmaz.

## 5. Kolon eşleştirmesi

### 5.1 Demografi (yeni hasta eklenirken veya boş hücreye)
| `.sav` kolonu | Kaynak | Dönüşüm |
|---|---|---|
| `Adsoyad` | Ad Soyad | PDF'teki gibi (büyük harf, Türkçe karakter) |
| `DosyaNo` | Protokol / Dosya No | string |
| `CinsiyetK1E2` | Cinsiyet | `K`/`Kadın` → 1, `E`/`Erkek` → 2 |
| `Yaş` | Doğum tarihi | **Tahlil anındaki tam yaş**: doğum tarihi → o hasta için kullanılan **en güncel lab raporunun Numune Alma Zamanı**. Lab raporu yoksa eko Çekim Tarihi. Doğum günü geçmemişse −1. |

### 5.2 Laboratuvar
| PDF Test Adı (tam) | `.sav` kolonu | Dönüşüm |
|---|---|---|
| `Pro-BNP` | `ProBNP` | |
| `Glukoz` | `AKŞ` | |
| `Kreatinin` | `Kre` | |
| `Glomerüler Filtrasyon Hızı` | `eGFR` | |
| `Ürik asit` | `Ürik_asit` | |
| `Protein, Total` | `Totalprotein` | |
| `Albumin` | `Alb` | |
| `Sodyum` | `Na` | |
| `Potasyum` | `K` | |
| `Kalsiyum` | `Ca` | |
| `Fosfor` | `PO4` | |
| `AST` | `AST` | |
| `ALT` | `ALT` | |
| `Trigliserid` | `TG` | |
| `Kolesterol, Total` | `Totalkolesterol` | |
| `Kolesterol LDL` | `LDL` | |
| `Kolesterol, HDL` | `HDL` | |
| `Ferritin` | `Ferritin` | |
| `Transferrin Saturasyonu` | `TS` | |
| `HGB (Hemoglobin)` | `Hb` | |
| `PLT (Trombosit)` | `PLT` | |
| `WBC (Lökosit)` | `Lökosit` | **× 1000** (5,99 → 5990) |
| `Nötrofil# (Nötrofil Sayısı)` | `Nötrofil` | **× 1000** |
| `Lenfosit# (Lenfosit Sayısı)` | `Lenfosit` | **× 1000** |
| `Albümin / Kreatinin (Spot İdrar)` | `Spotidraralbuminüri` | |
| `Protein / Kreatinin(Spot İdrar)` | `Spotidrarproteinüri` | |

`Parathormon` → `PTH`, `CRP Nefelometrik` → `CRP`, `cHCO3(Pst)c (Venöz)` → `HCO3` (Word örneğiyle ve listedeki elle girilmiş değerlerle doğrulandı). Listede `AKŞ` kolonunun adı `glukoz` olarak değişti; ikisi de desteklenir (`COLUMN_ALIASES`). Eşleştirme tablosu **tek bir config dosyasında** (`src/mapping.ts`); yeni test tek satırla eklenir.

### 5.3 Eko
| Kaynak | `.sav` kolonu | Kural |
|---|---|---|
| Bulgular: `Ejeksiyon Fraksiyonu` (BULGU) | `EFyüzde` | sayı |
| Bulgular: `E/A Oranı` | `e_a` | `<1` → 0, `>1` → 1, sayı ise <1 → 0, >1 → 1; boş/diğer → boş |
| Bulgular: `SOL ATRİYUM` (BULGU) | `Sol_atriyum_çapı` | cm, sayı |
| Bulgular: `PulmonerArterBasıncı` | `pab` | `36 mmHg` → 36. Yoksa Sonuç metninde `PAB: <sayı>` |
| Sonuç metni: `TAPSE: 23 mm` | `TAPSE` | mm, sayı |
| Sonuç metni: `IVC: 23 mm` / `VCI: 23 mm` | `VCI_çapı_ekspiryum` | mm, sayı |
| Sonuç metni: `%50'den fazla kollabe` | `VCI_kollabe` | `fazla` → 1, `az` → 0; eşleşme yoksa boş |

**Yorum gerektiren kolonlar — her zaman boş bırakılır, uygulama dokunmaz:**
`Kapak_patolojisi`, `Kapak_patolojisi_tipi`, `Sol_ventrikül_hipertrofisi`, `Diyastolik_disfonksiyon`.

Diğer tüm kolonlar (Boy, Kilo, komorbiditeler, ilaçlar vb.) elle girilir; uygulama dokunmaz.

## 6. Birleştirme kuralları
1. **Aynı test birden fazla PDF'te varsa:** yüklenen PDF'ler arasında **en güncel** tarihli olan alınır (lab: Numune Alma Zamanı, eko: Çekim Tarihi). Aynı tarih ve farklı değer → yazma, çakışma uyarısı.
2. **Hücre `.sav`'da boşsa:** yaz.
3. **Hücre doluysa ve değer aynıysa:** hiçbir şey yapma.
4. **Hücre doluysa ve değer farklıysa:** **üzerine yazma**, önizlemede "Çakışma: listede X, PDF'te Y (tarih, dosya)" göster. (İleride tek tık "PDF'tekini kullan" eklenebilir; v1'de yok.)
5. **DosyaNo listede yoksa:** yeni satır olarak **sona** ekle. Mevcut boş satırlara dokunma.
6. Bulunamayan değer → hücre boş kalır (numeric: SYSMIS, string: boşluk).

## 7. Önizleme ekranı
Hasta bazında kart:
- Başlık: Ad Soyad, DosyaNo, "Yeni hasta" / "Mevcut hasta" rozeti
- Tablo: `Kolon | Listedeki değer | Yeni değer | Kaynak PDF | Tarih | Durum`
  - Durum: ✅ Yazılacak / ⚪ Zaten aynı / ⚠️ Çakışma (yazılmayacak) / ⚠️ Uyarı (hemoliz, `<`/`>` değer)
- En üstte özet: "3 hasta, 42 değer yazılacak, 1 çakışma, 1 tanınmayan PDF"
- Kaydet butonu yalnızca yazılacak ≥ 1 değer varsa aktif.

## 8. `.sav` okuma/yazma modülü (`src/sav/`)
Referans: PSPP "System File Format" dokümantasyonu.

Örnek dosyanın özellikleri (SPSS 20, Windows):
- `$FL2` (zsav değil), **bytecode compression = 1, bias = 100**
- 77 değişken / 98 slot (string'ler 8 byte'lık segmentler), en uzun string A96 (< 256, very long string yok)
- Kayıtlar: type 2 (98), 3+4 value labels (32), 7.3, 7.4, 7.11, 7.13 (uzun değişken adları), **7.16 (64-bit case sayısı)**, 7.18, 7.20 (**encoding: `windows-1254`**), 7.24 (dataview XML), 999
- String değerler **windows-1254** ile encode/decode edilir (`TextDecoder('windows-1254')` okuma için var; yazma için küçük bir 1254 tablosu yaz — `TextEncoder` sadece UTF-8 destekliyor).

**Strateji — sözlüğü aynen koru:**
1. Okurken: file header + type 999'a kadar tüm sözlük kayıtlarını **ham byte olarak** sakla. Sadece gereken bilgiyi parse et: değişken adları (7.13'ten uzun adlar), tip/genişlik, slot düzeni.
2. Veri bölümünü bytecode decompress edip satırlara çevir.
3. Yazarken: sözlüğü byte byte aynen yaz; sadece header'daki `ncases` (offset 80, int32) ve 7.16 kaydındaki case sayısını güncelle. Veriyi aynı bias ile bytecode compress ederek yaz.
4. Böylece value label'lar, formatlar, measure'lar, SPSS'in XML kaydı vs. hiç bozulmaz.

## 9. Testler (Vitest)
- `fixtures/` klasörü **`.gitignore`'da** (gerçek hasta verisi, repo public). CI'da fixture'lar yoksa bu testler skip edilir; anonimleştirilmiş fixture üretilirse CI'da da koşar.
- Fixture adları nötrdür (`a_biyokimya.pdf`, `b_eko.pdf`, `liste.sav` …). Hastaların kimlik bilgileri (ad, dosya no, doğum tarihi, rapor tarihleri) koda/SPEC'e yazılmaz; testler bunları `fixtures/patients.json`'dan okur.
- **SAV round-trip:** oku → değiştirmeden yaz → **byte-identical** olmalı.
- **SAV değişiklik:** bir hücre doldur + yeni satır ekle → yaz → `scripts/verify_sav.py` (pyreadstat) ile oku, beklenen DataFrame ile karşılaştır. (Lokal çalıştırılır.)
- **Lab parse — referans değerler** (mevcut listeyle doğrulandı):
  - Hasta A, Biyokimya: AKŞ 83, Kre 1.24, eGFR 47, Ürik_asit 4.95, Totalprotein 7.7, Alb 4.9, Na 140, K 3.9 (hemoliz uyarısı), Ca 10.5, PO4 4.6, AST 23, ALT 24, TG 162, Totalkolesterol 173, LDL 75, HDL 66, TS 19
  - Hemogram: Hb 13.0, PLT 243, Lökosit 5990, Nötrofil 3850, Lenfosit 1570
  - Hormon: Ferritin 31.5 · Kardiyak: ProBNP 1072 · Spot idrar: albuminüri 61, proteinüri 209
  - Hasta B (E), Hemogram: Hb 12.6, PLT 108, Lökosit 5410, Nötrofil 3550, Lenfosit 1250 — **"Önceki Sonuçlar" (12,7 / 12,6 / 11,6 vb.) alınmamalı**. Yaş (en güncel lab raporu itibarıyla) = 86.
  - Hasta A yaş (lab raporu itibarıyla) = 70.
- **Eko parse:** Hasta A: EFyüzde 60, e_a 0, Sol_atriyum_çapı 3.5, TAPSE 23, VCI_çapı_ekspiryum 23, VCI_kollabe 1, pab 36; yorum kolonları boş.
- **Birleştirme:** Hasta A'nın listedeki Ferritin=20 ve Yaş=71 → PDF'teki 31.5 / 70 ile **çakışma**, üzerine yazılmaz.
- Negatif testler: `Kreatinin (Spot İdrar)` → `Kre`'ye yazılmamalı; `Kolesterol, Non-HDL` → `HDL`'ye yazılmamalı.

## 10. Kapsam dışı (v1)
OCR, başka hastanelerin PDF formatları, yorum gerektiren eko kolonları, çakışmada üzerine yazma, Excel çıktısı.
