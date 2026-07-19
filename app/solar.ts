const radians = (degrees: number) => degrees * Math.PI / 180;
const degrees = (radiansValue: number) => radiansValue * 180 / Math.PI;
const normalize = (value: number, maximum: number) => ((value % maximum) + maximum) % maximum;

function solarUtcHour(date: Date, latitude: number, longitude: number, sunrise: boolean): number | undefined {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000);
  const lngHour = longitude / 15;
  const approximate = day + ((sunrise ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * approximate - 3.289;
  let trueLongitude = meanAnomaly + 1.916 * Math.sin(radians(meanAnomaly)) +
    0.02 * Math.sin(radians(2 * meanAnomaly)) + 282.634;
  trueLongitude = normalize(trueLongitude, 360);
  let rightAscension = degrees(Math.atan(0.91764 * Math.tan(radians(trueLongitude))));
  rightAscension = normalize(rightAscension, 360);
  rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;
  const sinDeclination = 0.39782 * Math.sin(radians(trueLongitude));
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  const cosHour = (Math.cos(radians(90.833)) - sinDeclination * Math.sin(radians(latitude))) /
    (cosDeclination * Math.cos(radians(latitude)));
  if (cosHour < -1 || cosHour > 1) return undefined;
  const hourAngle = (sunrise ? 360 - degrees(Math.acos(cosHour)) : degrees(Math.acos(cosHour))) / 15;
  const localMean = hourAngle + rightAscension - 0.06571 * approximate - 6.622;
  return normalize(localMean - lngHour, 24);
}

export function solarTimes(date: Date, latitude: number, longitude: number) {
  const makeDate = (hour: number | undefined) => {
    if (hour === undefined) return undefined;
    const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    result.setUTCMinutes(Math.round(hour * 60));
    return result;
  };
  return {
    sunrise: makeDate(solarUtcHour(date, latitude, longitude, true)),
    sunset: makeDate(solarUtcHour(date, latitude, longitude, false)),
  };
}
