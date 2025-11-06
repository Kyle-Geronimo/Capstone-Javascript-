// Hotel locations data
const hotelWeatherData = [
    {
        name: "D'Mariners Inn Hotel",
        latitude: 13.770073,
        longitude: 121.067761
    },
    {
        name: "Wennrod Hotel",
        latitude: 13.767925519805514,
        longitude: 121.07173400787799
    },
    {
        name: "Bicotels Hotel",
        latitude: 13.768395033709945,
        longitude: 121.0676696167118
    }
];

// Convert weather code to emoji icon
function getWeatherIcon(code) {
    const weatherIcons = {
        0: '☀️', // Clear sky
        1: '🌤️', // Mainly clear
        2: '⛅', // Partly cloudy
        3: '☁️', // Overcast
        45: '🌫️', // Foggy
        48: '🌫️', // Depositing rime fog
        51: '🌦️', // Light drizzle
        53: '🌦️', // Moderate drizzle
        55: '🌦️', // Dense drizzle
        56: '🌧️', // Light freezing drizzle
        57: '🌧️', // Dense freezing drizzle
        61: '🌧️', // Slight rain
        63: '🌧️', // Moderate rain
        65: '🌧️', // Heavy rain
        66: '🌧️', // Light freezing rain
        67: '🌧️', // Heavy freezing rain
        71: '🌨️', // Slight snow fall
        73: '🌨️', // Moderate snow fall
        75: '🌨️', // Heavy snow fall
        77: '❄️', // Snow grains
        80: '🌦️', // Slight rain showers
        81: '🌧️', // Moderate rain showers
        82: '🌧️', // Violent rain showers
        85: '🌨️', // Slight snow showers
        86: '🌨️', // Heavy snow showers
        95: '⛈️', // Thunderstorm
        96: '⛈️', // Thunderstorm with slight hail
        99: '⛈️'  // Thunderstorm with heavy hail
    };
    return weatherIcons[code] || '❓';
}

// Get current weather data for a location
async function fetchWeatherData(latitude, longitude) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m,precipitation,relative_humidity_2m,rain,precipitation_probability,weather_code&timezone=Asia%2FSingapore`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        // Get current hour index
        const now = new Date();
        const currentHourIndex = now.getHours();
        
        return {
            temperature: data.hourly.temperature_2m[currentHourIndex],
            humidity: data.hourly.relative_humidity_2m[currentHourIndex],
            precipitation: data.hourly.precipitation[currentHourIndex],
            rainChance: data.hourly.precipitation_probability[currentHourIndex],
            weatherCode: data.hourly.weather_code[currentHourIndex]
        };
    } catch (error) {
        console.error('Error fetching weather data:', error);
        return null;
    }
}

// Create weather display cards
export async function initializeWeatherCards() {
    const weatherContainer = document.getElementById('weather-container');
    if (!weatherContainer) return;

    for (const hotel of hotelWeatherData) {
        try {
            const weatherData = await fetchWeatherData(hotel.latitude, hotel.longitude);
            if (!weatherData) continue;

            const weatherIcon = getWeatherIcon(weatherData.weatherCode);
            const card = document.createElement('div');
            card.className = 'weather-card';
            card.innerHTML = `
                <h3>${hotel.name}</h3>
                <div class="weather-icon">${weatherIcon}</div>
                <div class="weather-details">
                    <p><strong>Temperature:</strong> ${weatherData.temperature}°C</p>
                    <p><strong>Humidity:</strong> ${weatherData.humidity}%</p>
                    <p><strong>Precipitation:</strong> ${weatherData.precipitation}mm</p>
                    <p><strong>Rain Chance:</strong> ${weatherData.rainChance}%</p>
                </div>
            `;
            weatherContainer.appendChild(card);
        } catch (error) {
            console.error(`Error creating weather card for ${hotel.name}:`, error);
        }
    }
}