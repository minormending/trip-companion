/**
 * Countries that use exactly one timezone year-round-ish. Photon returns a
 * country code but no zone, and for these the mapping is unambiguous, which
 * turns an estimated photo time into an exact one. Multi-zone countries (US,
 * RU, CN, AU, BR, CA, MX, ID, KZ) are deliberately absent — for those the
 * longitude estimate is shown and labelled as such.
 */
const SINGLE_ZONE: Record<string, string> = {
  jp: 'Asia/Tokyo', kr: 'Asia/Seoul', tw: 'Asia/Taipei', hk: 'Asia/Hong_Kong',
  sg: 'Asia/Singapore', th: 'Asia/Bangkok', vn: 'Asia/Ho_Chi_Minh', kh: 'Asia/Phnom_Penh',
  la: 'Asia/Vientiane', mm: 'Asia/Yangon', np: 'Asia/Kathmandu', lk: 'Asia/Colombo',
  in: 'Asia/Kolkata', bd: 'Asia/Dhaka', pk: 'Asia/Karachi', ae: 'Asia/Dubai',
  qa: 'Asia/Qatar', sa: 'Asia/Riyadh', il: 'Asia/Jerusalem', jo: 'Asia/Amman',
  tr: 'Europe/Istanbul', gr: 'Europe/Athens', gb: 'Europe/London', ie: 'Europe/Dublin',
  fr: 'Europe/Paris', be: 'Europe/Brussels', nl: 'Europe/Amsterdam', lu: 'Europe/Luxembourg',
  de: 'Europe/Berlin', ch: 'Europe/Zurich', at: 'Europe/Vienna', cz: 'Europe/Prague',
  sk: 'Europe/Bratislava', pl: 'Europe/Warsaw', hu: 'Europe/Budapest', si: 'Europe/Ljubljana',
  hr: 'Europe/Zagreb', it: 'Europe/Rome', es: 'Europe/Madrid', pt: 'Europe/Lisbon',
  dk: 'Europe/Copenhagen', no: 'Europe/Oslo', se: 'Europe/Stockholm', fi: 'Europe/Helsinki',
  ee: 'Europe/Tallinn', lv: 'Europe/Riga', lt: 'Europe/Vilnius', ro: 'Europe/Bucharest',
  bg: 'Europe/Sofia', rs: 'Europe/Belgrade', is: 'Atlantic/Reykjavik', ma: 'Africa/Casablanca',
  eg: 'Africa/Cairo', za: 'Africa/Johannesburg', ke: 'Africa/Nairobi', tz: 'Africa/Dar_es_Salaam',
  ng: 'Africa/Lagos', gh: 'Africa/Accra', et: 'Africa/Addis_Ababa', nz: 'Pacific/Auckland',
  fj: 'Pacific/Fiji', pe: 'America/Lima', co: 'America/Bogota', ve: 'America/Caracas',
  cl: 'America/Santiago', ar: 'America/Argentina/Buenos_Aires', uy: 'America/Montevideo',
  py: 'America/Asuncion', bo: 'America/La_Paz', ec: 'America/Guayaquil', cr: 'America/Costa_Rica',
  pa: 'America/Panama', gt: 'America/Guatemala', cu: 'America/Havana', jm: 'America/Jamaica',
}

export function timezoneForCountry(countryCode: string | undefined): string | undefined {
  if (!countryCode) return undefined
  return SINGLE_ZONE[countryCode.toLowerCase()]
}
