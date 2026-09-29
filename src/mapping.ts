// PDF → .sav column mapping. This is the ONLY place to edit when a new test is added.
//
// Lab tests: the PDF "Test Adı" must match EXACTLY (after trimming and collapsing spaces).
// `scale` multiplies the value by 10^scale (WBC 5,99 x10^3/uL → 5990 means scale: 3).

export interface LabMapping {
  test: string;
  column: string;
  scale?: number;
}

export const LAB_MAPPING: LabMapping[] = [
  { test: 'Pro-BNP', column: 'ProBNP' },
  { test: 'Glukoz', column: 'glukoz' },
  { test: 'Kreatinin', column: 'Kre' },
  { test: 'Glomerüler Filtrasyon Hızı', column: 'eGFR' },
  { test: 'Ürik asit', column: 'Ürik_asit' },
  { test: 'Protein, Total', column: 'Totalprotein' },
  { test: 'Albumin', column: 'Alb' },
  { test: 'Sodyum', column: 'Na' },
  { test: 'Potasyum', column: 'K' },
  { test: 'Kalsiyum', column: 'Ca' },
  { test: 'Fosfor', column: 'PO4' },
  { test: 'AST', column: 'AST' },
  { test: 'ALT', column: 'ALT' },
  { test: 'Trigliserid', column: 'TG' },
  { test: 'Kolesterol, Total', column: 'Totalkolesterol' },
  { test: 'Kolesterol LDL', column: 'LDL' },
  { test: 'Kolesterol, HDL', column: 'HDL' },
  { test: 'Ferritin', column: 'Ferritin' },
  { test: 'Transferrin Saturasyonu', column: 'TS' },
  { test: 'HGB (Hemoglobin)', column: 'Hb' },
  { test: 'PLT (Trombosit)', column: 'PLT' },
  { test: 'WBC (Lökosit)', column: 'Lökosit', scale: 3 },
  { test: 'Nötrofil# (Nötrofil Sayısı)', column: 'Nötrofil', scale: 3 },
  { test: 'Lenfosit# (Lenfosit Sayısı)', column: 'Lenfosit', scale: 3 },
  { test: 'Albümin / Kreatinin (Spot İdrar)', column: 'Spotidraralbuminüri' },
  { test: 'Protein / Kreatinin(Spot İdrar)', column: 'Spotidrarproteinüri' },
  // Units checked against values already entered in the list (pg/mL, mg/L, mmol/L).
  { test: 'Parathormon', column: 'PTH' },
  { test: 'CRP Nefelometrik', column: 'CRP' },
  { test: 'cHCO3(Pst)c (Venöz)', column: 'HCO3' },
];

/**
 * Columns that were renamed in the list at some point. When writing, the first name that
 * exists in the opened .sav file is used.
 */
export const COLUMN_ALIASES: string[][] = [['glukoz', 'AKŞ']];

/** Echo findings table rows (value taken from the BULGU column). */
export const ECHO_FINDINGS = {
  ef: 'Ejeksiyon Fraksiyonu',
  ea: 'E/A Oranı',
  leftAtrium: 'SOL ATRİYUM',
  pab: 'PulmonerArterBasıncı',
} as const;

export const ECHO_COLUMNS = {
  ef: 'EFyüzde',
  ea: 'e_a',
  leftAtrium: 'Sol_atriyum_çapı',
  pab: 'pab',
  tapse: 'TAPSE',
  ivc: 'VCI_çapı_ekspiryum',
  ivcCollapse: 'VCI_kollabe',
} as const;

export const DEMOGRAPHIC_COLUMNS = {
  name: 'Adsoyad',
  fileNo: 'DosyaNo',
  sex: 'CinsiyetK1E2',
  age: 'Yaş',
} as const;

export function normalizeName(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

const LAB_BY_TEST = new Map(LAB_MAPPING.map((m) => [normalizeName(m.test), m]));

export function findLabMapping(testName: string): LabMapping | undefined {
  return LAB_BY_TEST.get(normalizeName(testName));
}

/** Every column the app may write — used to check that the list has them. */
export function allTargetColumns(): string[] {
  return [
    ...Object.values(DEMOGRAPHIC_COLUMNS),
    ...LAB_MAPPING.map((m) => m.column),
    ...Object.values(ECHO_COLUMNS),
  ];
}
