export type DstYearRule = {
  year: number;
  startDay: number;
  endDay: number;
  startMinutes: number;
  endMinutes: number;
  offsetMinutes: number;
  leap: boolean;
};

export type DstRuleSet = {
  name: string;
  rules: DstYearRule[];
};

const DST_FILES: Record<string, string> = {
  "No daylight saving": "DST_No Daylight Saving.DST",
  "UK / Europe": "DST_UK-Europe.DST",
  USA: "DST_USA.DST",
};

export function parseDstRuleFile(source: string): DstRuleSet {
  const lines = source.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 6) throw new Error("DST rule file is incomplete");
  const [startQuarter, endQuarter, offsetHalfHours] = lines[4].split(",").map(Number);
  if (![startQuarter, endQuarter, offsetHalfHours].every(Number.isFinite))
    throw new Error("DST rule file header is invalid");
  const records = lines.slice(5).map((line) => line.split(",").map(Number));
  const rules = records.flatMap(([startDay, encodedEndDay, leap], index) => {
    if (![startDay, encodedEndDay, leap].every(Number.isFinite)) return [];
    // The recovered files put 2100–2116 first, followed by 2017–2099.
    const year = index < 17 ? 2100 + index : 2017 + index - 17;
    return [{
      year,
      startDay,
      endDay: encodedEndDay + 128,
      startMinutes: startQuarter * 15,
      endMinutes: endQuarter * 15,
      offsetMinutes: offsetHalfHours * 30,
      leap: Boolean(leap),
    }];
  });
  return { name: lines[0], rules };
}

export async function loadDstRuleSet(name: string): Promise<DstRuleSet> {
  const file = DST_FILES[name] ?? DST_FILES["UK / Europe"];
  const response = await fetch(`/flexidim/dst/${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(`Unable to load ${file}`);
  return parseDstRuleFile(await response.text());
}

export function dstTransition(rule: DstYearRule, edge: "start" | "end"): Date {
  const day = edge === "start" ? rule.startDay : rule.endDay;
  const minutes = edge === "start" ? rule.startMinutes : rule.endMinutes;
  return new Date(Date.UTC(rule.year, 0, day, Math.floor(minutes / 60), minutes % 60));
}

export function isDstActive(rule: DstYearRule, date: Date): boolean {
  if (!rule.offsetMinutes) return false;
  const timestamp = date.getTime();
  return timestamp >= dstTransition(rule, "start").getTime() &&
    timestamp < dstTransition(rule, "end").getTime();
}

export { DST_FILES };
