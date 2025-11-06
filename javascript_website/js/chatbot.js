import { db, auth } from './firebase-config.js';
import { collection, getDocs, query, orderBy } from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

export async function loadChatbotData() {
  const container = document.getElementById('chatbot-data');
  if (!container) return;

  try {
    // Check authentication status
    if (!auth.currentUser) {
      container.innerHTML = '<div class="auth-message"><p>Please log in to view hotel information.</p></div>';
      return;
    }

    // Create a query to get all hotels, ordered by name
    const hotelsQuery = query(
      collection(db, 'hotels'),
      orderBy('name', 'asc')
    );
    
    // Get the hotels data
    const snap = await getDocs(hotelsQuery);
    
    if (snap.empty) {
      container.innerHTML = "<em>No hotel information available.</em>";
      return;
    }

    // Format and display the hotel data
    container.innerHTML = `
      <div class="hotels-grid">
        ${snap.docs.map(doc => {
          const hotel = doc.data();
          return `
            <div class="hotel-card">
              <h3 class="hotel-name">${escapeHtml(hotel.name || 'Unnamed Hotel')}</h3>
              ${hotel.image ? `<img src="${escapeHtml(hotel.image)}" alt="${escapeHtml(hotel.name)}" class="hotel-image">` : ''}
              <div class="hotel-details">
                ${hotel.address ? `<p><strong>Address:</strong> ${escapeHtml(hotel.address)}</p>` : ''}
                ${hotel.phone ? `<p><strong>Phone:</strong> ${escapeHtml(hotel.phone)}</p>` : ''}
                ${hotel.email ? `<p><strong>Email:</strong> ${escapeHtml(hotel.email)}</p>` : ''}
                ${hotel.description ? `<p class="hotel-description">${escapeHtml(hotel.description)}</p>` : ''}
                ${hotel.amenities ? `
                  <div class="hotel-amenities">
                    <strong>Amenities:</strong>
                    <ul>
                      ${hotel.amenities.map(amenity => `<li>${escapeHtml(amenity)}</li>`).join('')}
                    </ul>
                  </div>
                ` : ''}
                ${hotel.rooms ? `
                  <div class="hotel-rooms">
                    <strong>Room Types:</strong>
                    <ul>
                      ${Object.entries(hotel.rooms).map(([type, details]) => `
                        <li>${escapeHtml(type)}: ${escapeHtml(details.description || '')}
                        ${details.rate ? ` - ₱${details.rate}/night` : ''}</li>
                      `).join('')}
                    </ul>
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<em>Error loading hotel data: ${escapeHtml(err.message)}</em>`;
    console.error('Error loading hotel data:', err);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
