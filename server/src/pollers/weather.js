const POLL_MINUTES = 15

async function pollOnce(config, state) {
  const { latitude, longitude } = config.weather
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.search = new URLSearchParams({
    latitude,
    longitude,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '7'
  }).toString()

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const data = await res.json()

  state.weather = {
    current: {
      temp: data.current.temperature_2m,
      feelsLike: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      windMph: data.current.wind_speed_10m,
      code: data.current.weather_code
    },
    sun: { sunrise: data.daily.sunrise[0], sunset: data.daily.sunset[0] },
    // Next 12 hours, starting from the current hour (Open-Meteo returns local time)
    hourly: data.hourly.time
      .map((time, i) => ({
        time,
        temp: data.hourly.temperature_2m[i],
        code: data.hourly.weather_code[i],
        precipChance: data.hourly.precipitation_probability[i]
      }))
      .filter((h) => new Date(h.time).getTime() >= Date.now() - 30 * 60 * 1000)
      .slice(0, 12),
    daily: data.daily.time.map((date, i) => ({
      date,
      code: data.daily.weather_code[i],
      high: data.daily.temperature_2m_max[i],
      low: data.daily.temperature_2m_min[i],
      precipChance: data.daily.precipitation_probability_max[i]
    })),
    updatedAt: Date.now()
  }
}

export function startWeatherPoller(config, state) {
  const run = () => pollOnce(config, state).catch((err) => {
    console.warn('Weather poll failed:', err.message)
    // Boot-time network races shouldn't leave the display blank for 15 min
    if (!state.weather) setTimeout(run, 45 * 1000)
  })
  run()
  setInterval(run, POLL_MINUTES * 60 * 1000)
}
