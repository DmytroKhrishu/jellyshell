import {
  Sun, Moon, CloudSun, CloudMoon, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning, CloudHail,
} from 'lucide-preact';

type I = typeof Sun;
const T: Record<number, [string, I, I?]> = {
  0: ['Clear', Sun, Moon],
  1: ['Mostly clear', CloudSun, CloudMoon],
  2: ['Partly cloudy', CloudSun, CloudMoon],
  3: ['Overcast', Cloud],
  45: ['Fog', CloudFog],
  48: ['Rime fog', CloudFog],
  51: ['Light drizzle', CloudDrizzle],
  53: ['Drizzle', CloudDrizzle],
  55: ['Heavy drizzle', CloudDrizzle],
  56: ['Freezing drizzle', CloudDrizzle],
  57: ['Freezing drizzle', CloudDrizzle],
  61: ['Light rain', CloudRain],
  63: ['Rain', CloudRain],
  65: ['Heavy rain', CloudRain],
  66: ['Freezing rain', CloudHail],
  67: ['Freezing rain', CloudHail],
  71: ['Light snow', CloudSnow],
  73: ['Snow', CloudSnow],
  75: ['Heavy snow', CloudSnow],
  77: ['Snow grains', CloudSnow],
  80: ['Showers', CloudRain],
  81: ['Showers', CloudRain],
  82: ['Violent showers', CloudRain],
  85: ['Snow showers', CloudSnow],
  86: ['Snow showers', CloudSnow],
  95: ['Thunderstorm', CloudLightning],
  96: ['Thunderstorm, hail', CloudLightning],
  99: ['Thunderstorm, hail', CloudLightning],
};

export function wmo(code: number, isDay = true): { label: string; Icon: I } {
  const [label, day, night] = T[code] ?? ['—', Cloud];
  return { label, Icon: !isDay && night ? night : day };
}

export function aqiLabel(v: number | null | undefined) {
  if (v == null) return '—';
  if (v <= 20) return 'Good';
  if (v <= 40) return 'Fair';
  if (v <= 60) return 'Moderate';
  if (v <= 80) return 'Poor';
  if (v <= 100) return 'Very poor';
  return 'Extremely poor';
}

export function uvLabel(v: number) {
  if (v < 3) return 'Low';
  if (v < 6) return 'Moderate';
  if (v < 8) return 'High';
  if (v < 11) return 'Very high';
  return 'Extreme';
}
