/**
 * The sunrise and sunset table the Scene Controller is given.
 *
 * Periods can start or end relative to sunrise or sunset ("30 minutes before
 * sunset"), and the controller has no almanac of its own, so the configuration
 * image carries a full year of sunrise and sunset times computed for the site's
 * latitude and longitude. It is 373 daily records of four bytes:
 *
 *     [sunrise minute, sunrise hour, sunset minute, sunset hour]
 *
 * All times are UTC — the app labels its own display of them "(non-DST)", and
 * the controller applies any local offset itself.
 *
 * The algorithm is Montenbruck & Pfleger's, identified from the method names
 * left in the iOS app (`miniSun:`, `sinAltSun:hour:longitude:cglat:sglat:`,
 * `sunEvent:month:day:tz:long:lat:event:`). Ported here and checked against the
 * table the real compiler produced: all 730 sunrise and sunset values for the
 * reference site match to the minute, with no exceptions.
 *
 * NOTE FOR ANYONE COMPARING CHECKSUMS: the table is built for the CURRENT year,
 * so a configuration's checksum legitimately changes when the year turns. Two
 * checksums are only comparable if they were computed in the same year.
 */

const TWO_PI = 2 * Math.PI;
const RADIANS = Math.PI / 180;

/** Sun altitude at sunrise and sunset: half a degree of disc plus refraction. */
const SUN_ALTITUDE_DEGREES = -0.833;

/**
 * Days in the table. A full year plus eight, so the controller can look a week
 * ahead without a special case at the end of December. Those eight trailing
 * records are NOT next January — the app repeats the table's own first days, so
 * they are copies of 1 January onward for the same year.
 */
export const SUN_TABLE_DAYS = 373;
export const SUN_RECORD_BYTES = 4;

function fractionalPart(value: number): number {
  const rest = value - Math.floor(value);
  return rest < 0 ? rest + 1 : rest;
}

/** Modified Julian Date, the algorithm's time base. */
function modifiedJulianDate(day: number, month: number, year: number, hour: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    m += 12;
    y -= 1;
  }
  const stamp = 10000 * y + 100 * m + day;
  const calendar =
    stamp <= 15821004.1
      ? -2 * Math.floor((y + 4716) / 4) - 1179
      : Math.floor(y / 400) - Math.floor(y / 100) + Math.floor(y / 4);
  return 365 * y - 679004 + calendar + Math.floor(30.6001 * (m + 1)) + day + hour / 24;
}

/** Low-precision solar position: right ascension in hours, declination in degrees. */
function miniSun(centuries: number): { rightAscension: number; declination: number } {
  const cosObliquity = 0.91748;
  const sinObliquity = 0.39778;
  const meanAnomaly = TWO_PI * fractionalPart(0.993133 + 99.997361 * centuries);
  const centre = 6893 * Math.sin(meanAnomaly) + 72 * Math.sin(2 * meanAnomaly);
  const longitude =
    TWO_PI *
    fractionalPart(0.7859453 + meanAnomaly / TWO_PI + (6191.2 * centuries + centre) / 1296e3);
  const sinLongitude = Math.sin(longitude);
  const x = Math.cos(longitude);
  const y = cosObliquity * sinLongitude;
  const z = sinObliquity * sinLongitude;
  const rho = Math.sqrt(1 - z * z);
  const declination = (360 / TWO_PI) * Math.atan(z / rho);
  let rightAscension = (48 / TWO_PI) * Math.atan(y / (x + rho));
  if (rightAscension < 0) rightAscension += 24;
  return { rightAscension, declination };
}

/** Local mean sidereal time, in hours. */
function localSiderealTime(instant: number, longitude: number): number {
  const wholeDay = Math.floor(instant);
  const universalTime = (instant - wholeDay) * 24;
  const centuries = (wholeDay - 51544.5) / 36525;
  const greenwich =
    6.697374558 +
    1.0027379093 * universalTime +
    ((8640184.812866 + (0.093104 - 6.2e-6 * centuries) * centuries) * centuries) / 3600;
  return 24 * fractionalPart((greenwich + longitude / 15) / 24);
}

/** Sine of the sun's altitude at a given hour. */
function sinAltitude(
  midnight: number,
  hour: number,
  longitude: number,
  cosLatitude: number,
  sinLatitude: number,
): number {
  const instant = midnight + hour / 24;
  const { rightAscension, declination } = miniSun((instant - 51544.5) / 36525);
  const hourAngle = 15 * (localSiderealTime(instant, longitude) - rightAscension);
  return (
    sinLatitude * Math.sin(declination * RADIANS) +
    cosLatitude * Math.cos(declination * RADIANS) * Math.cos(hourAngle * RADIANS)
  );
}

export type SunTimes = { rise: number | null; set: number | null };

/**
 * Sunrise and sunset for one day, as hours after UTC midnight.
 *
 * The day is walked in two-hour steps; where the sun's altitude crosses the
 * horizon a quadratic through three samples gives the crossing time.
 */
export function sunTimes(
  day: number,
  month: number,
  year: number,
  longitude: number,
  latitude: number,
): SunTimes {
  const cosLatitude = Math.cos(latitude * RADIANS);
  const sinLatitude = Math.sin(latitude * RADIANS);
  const horizon = Math.sin(SUN_ALTITUDE_DEGREES * RADIANS);
  const midnight = modifiedJulianDate(day, month, year, 0);

  let hour = 1;
  let rise: number | null = null;
  let set: number | null = null;
  let previous = sinAltitude(midnight, 0, longitude, cosLatitude, sinLatitude) - horizon;

  while (hour < 25 && (rise == null || set == null)) {
    const middle = sinAltitude(midnight, hour, longitude, cosLatitude, sinLatitude) - horizon;
    const next = sinAltitude(midnight, hour + 1, longitude, cosLatitude, sinLatitude) - horizon;

    const a = 0.5 * (previous + next) - middle;
    const b = 0.5 * (next - previous);
    const c = middle;
    const vertex = -b / (2 * a);
    const discriminant = b * b - 4 * a * c;

    if (discriminant >= 0) {
      const spread = (0.5 * Math.sqrt(discriminant)) / Math.abs(a);
      const first = vertex - spread;
      const second = vertex + spread;
      const crossings = [first, second].filter((z) => Math.abs(z) <= 1);
      if (crossings.length === 1) {
        if (previous < 0) rise = hour + crossings[0];
        else set = hour + crossings[0];
      } else if (crossings.length === 2) {
        rise = hour + (vertex < 0 ? second : first);
        set = hour + (vertex < 0 ? first : second);
      }
    }

    previous = next;
    hour += 2;
  }

  return { rise, set };
}

/**
 * Build the whole table for a site.
 *
 * `year` is the year the table is computed for — the real app uses the year it
 * is compiling in, so pass the current year to match it.
 */
export function buildSunTable(latitude: number, longitude: number, year: number): Uint8Array {
  const table = new Uint8Array(SUN_TABLE_DAYS * SUN_RECORD_BYTES);
  const start = Date.UTC(year, 0, 1);
  const daysInYear = (Date.UTC(year + 1, 0, 1) - start) / 86400000;
  for (let index = 0; index < SUN_TABLE_DAYS; index += 1) {
    if (index >= daysInYear) {
      // Wrap back to the start of the same year rather than running on into the
      // next one.
      const source = (index - daysInYear) * SUN_RECORD_BYTES;
      table.copyWithin(index * SUN_RECORD_BYTES, source, source + SUN_RECORD_BYTES);
      continue;
    }
    const date = new Date(start + index * 86400000);
    const { rise, set } = sunTimes(
      date.getUTCDate(),
      date.getUTCMonth() + 1,
      date.getUTCFullYear(),
      longitude,
      latitude,
    );
    const at = index * SUN_RECORD_BYTES;
    if (rise != null) {
      const minutes = Math.floor(rise * 60);
      table[at] = minutes % 60;
      table[at + 1] = Math.floor(minutes / 60);
    }
    if (set != null) {
      const minutes = Math.floor(set * 60);
      table[at + 2] = minutes % 60;
      table[at + 3] = Math.floor(minutes / 60);
    }
  }
  return table;
}
