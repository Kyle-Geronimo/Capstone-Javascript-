import { db, auth } from './firebase-config.js';
import { 
    collection, 
    getDocs, 
    addDoc, 
    query, 
    orderBy, 
    serverTimestamp,
    limit 
} from 'https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js';

// Function to categorize inquiries based on keywords
function categorizeInquiry(question) {
    question = question.toLowerCase();
    
    const categories = {
        'rooms': ['room', 'suite', 'accommodation', 'bed', 'booking', 'reserve', 'vacancy', 'check-in', 'checkout'],
        'dining': ['food', 'restaurant', 'breakfast', 'lunch', 'dinner', 'meal', 'menu', 'dining', 'eat'],
        'amenities': ['pool', 'gym', 'wifi', 'internet', 'parking', 'spa', 'fitness', 'facility'],
        'pricing': ['price', 'cost', 'rate', 'fee', 'charge', 'payment', 'discount', 'package'],
        'location': ['location', 'address', 'direction', 'where', 'map', 'nearby', 'area', 'distance'],
        'services': ['service', 'housekeeping', 'laundry', 'concierge', 'shuttle', 'transportation', 'pickup'],
        'events': ['event', 'meeting', 'conference', 'wedding', 'party', 'celebration', 'venue'],
        'policies': ['policy', 'rule', 'regulation', 'cancel', 'refund', 'pet', 'smoking']
    };

    for (const [category, keywords] of Object.entries(categories)) {
        if (keywords.some(keyword => question.includes(keyword))) {
            return category;
        }
    }

    return 'general';
}

// Function to save a new inquiry to Firestore
export async function saveInquiry(question) {
    try {
        if (!auth.currentUser) {
            throw new Error('User must be logged in to save inquiries');
        }

        // Automatically categorize the inquiry
        const category = categorizeInquiry(question);

        const inquiryData = {
            userId: auth.currentUser.uid,
            username: auth.currentUser.displayName || auth.currentUser.email,
            question: question,
            timestamp: serverTimestamp(),
            category: category
        };

        await addDoc(collection(db, 'chatbot'), inquiryData);
        // Refresh the table after saving
        await loadChatbotData();
    } catch (error) {
        console.error('Error saving inquiry:', error);
        throw error;
    }
}

// Function to load and display chatbot data
export async function loadChatbotData() {
    const container = document.getElementById('chatbot-data');
    if (!container) return;

    try {
        // Check authentication status
        if (!auth.currentUser) {
            container.innerHTML = '<div class="auth-message"><p>Please log in to view chatbot inquiries.</p></div>';
            return;
        }

        // Create a query to get all inquiries, ordered by timestamp
        const inquiriesQuery = query(
            collection(db, 'chatbot'),
            orderBy('timestamp', 'desc'),
            limit(100) // Limit to last 100 inquiries for performance
        );
        
        // Get the inquiries data
        const snap = await getDocs(inquiriesQuery);
        
        if (snap.empty) {
            container.innerHTML = "<div class='no-data'>No chatbot inquiries available.</div>";
            return;
        }

        // Define all possible categories
        const allCategories = [
            'all',
            'rooms',
            'dining',
            'amenities',
            'pricing',
            'location',
            'services',
            'events',
            'policies',
            'general'
        ];
        
        // Format and display the inquiries
        container.innerHTML = `
            <div class="chatbot-inquiries">
                <h2>Chatbot Inquiries</h2>
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th class="sortable" data-sort="time">
                                    Time
                                    <span class="sort-icon">↕</span>
                                </th>
                                <th>Question</th>
                                <th class="sortable" data-sort="category">
                                    Category
                                    <select class="category-filter">
                                        ${allCategories.map(cat => {
                                            const displayName = {
                                                'all': 'All Categories',
                                                'rooms': 'Rooms & Bookings',
                                                'dining': 'Dining & Restaurants',
                                                'amenities': 'Hotel Amenities',
                                                'pricing': 'Pricing & Rates',
                                                'location': 'Location & Directions',
                                                'services': 'Hotel Services',
                                                'events': 'Events & Venues',
                                                'policies': 'Hotel Policies',
                                                'general': 'General Inquiries'
                                            }[cat];
                                            return `<option value="${cat}">${displayName}</option>`;
                                        }).join('')}
                                    </select>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            ${snap.docs.map(doc => {
                                const inquiry = doc.data();
                                const timestamp = inquiry.timestamp?.toDate() || new Date();
                                return `
                                    <tr data-timestamp="${timestamp.getTime()}" data-category="${escapeHtml(inquiry.category || 'general')}">
                                        <td>${timestamp.toLocaleString()}</td>
                                        <td>${escapeHtml(inquiry.question || '')}</td>
                                        <td data-category="${escapeHtml(inquiry.category || 'general')}">${escapeHtml(inquiry.category || 'general')}</td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // Add event listeners for sorting and filtering
        const timeHeader = container.querySelector('th[data-sort="time"]');
        const categoryFilter = container.querySelector('.category-filter');
        let timeSort = 'desc'; // Start with newest first

        // Time sorting
        timeHeader.addEventListener('click', () => {
            const tbody = container.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            rows.sort((a, b) => {
                const timeA = parseInt(a.dataset.timestamp);
                const timeB = parseInt(b.dataset.timestamp);
                return timeSort === 'desc' ? timeB - timeA : timeA - timeB;
            });
            
            timeSort = timeSort === 'desc' ? 'asc' : 'desc';
            timeHeader.querySelector('.sort-icon').textContent = timeSort === 'desc' ? '↓' : '↑';
            
            tbody.innerHTML = '';
            rows.forEach(row => tbody.appendChild(row));
        });

        // Category filtering
        categoryFilter.addEventListener('change', (e) => {
            const selectedCategory = e.target.value;
            const rows = container.querySelectorAll('tbody tr');
            
            rows.forEach(row => {
                if (selectedCategory === 'all' || row.dataset.category === selectedCategory) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });
        });

        // Add some basic styling
        const style = document.createElement('style');
        style.textContent = `
            .chatbot-inquiries {
                padding: 20px;
                max-width: 100%;
            }
            .chatbot-inquiries h2 {
                margin-bottom: 20px;
                color: #333;
            }
            .table-container {
                overflow-x: auto;
            }
            .data-table {
                width: 100%;
                border-collapse: collapse;
                margin: 0 auto;
                background: #fff;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .data-table th {
                background: #f5f5f5;
                padding: 12px;
                text-align: left;
                font-weight: bold;
                color: #333;
                border-bottom: 2px solid #ddd;
            }
            .sortable {
                cursor: pointer;
                position: relative;
                user-select: none;
            }
            .sort-icon {
                margin-left: 5px;
                font-size: 14px;
                opacity: 0.6;
            }
            .category-filter {
                margin-left: 10px;
                padding: 4px 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                background: white;
                font-size: 14px;
                cursor: pointer;
            }
            .category-filter:hover {
                border-color: #999;
            }
            .sortable:hover {
                background: #eee;
            }
            /* Category styling */
            .data-table td:last-child {
                text-transform: capitalize;
                font-weight: 500;
                padding: 8px 12px;
                border-radius: 4px;
            }
            /* Category-specific colors */
            .data-table tr td:last-child[data-category="rooms"],
            .data-table tr[data-category="rooms"] td:last-child {
                background-color: #e3f2fd;
                color: #1565c0;
            }
            .data-table tr td:last-child[data-category="dining"],
            .data-table tr[data-category="dining"] td:last-child {
                background-color: #f3e5f5;
                color: #7b1fa2;
            }
            .data-table tr td:last-child[data-category="amenities"],
            .data-table tr[data-category="amenities"] td:last-child {
                background-color: #e8f5e9;
                color: #2e7d32;
            }
            .data-table tr td:last-child[data-category="pricing"],
            .data-table tr[data-category="pricing"] td:last-child {
                background-color: #fff3e0;
                color: #e65100;
            }
            .data-table tr td:last-child[data-category="location"],
            .data-table tr[data-category="location"] td:last-child {
                background-color: #e1f5fe;
                color: #0277bd;
            }
            .data-table tr td:last-child[data-category="services"],
            .data-table tr[data-category="services"] td:last-child {
                background-color: #f1f8e9;
                color: #558b2f;
            }
            .data-table tr td:last-child[data-category="events"],
            .data-table tr[data-category="events"] td:last-child {
                background-color: #fce4ec;
                color: #c2185b;
            }
            .data-table tr td:last-child[data-category="policies"],
            .data-table tr[data-category="policies"] td:last-child {
                background-color: #ede7f6;
                color: #4527a0;
            }
            .data-table tr td:last-child[data-category="general"],
            .data-table tr[data-category="general"] td:last-child {
                background-color: #f5f5f5;
                color: #616161;
            }
            /* Style the category filter dropdown */
            .category-filter {
                margin-left: 10px;
                padding: 4px 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                background: white;
                font-size: 14px;
                cursor: pointer;
                font-weight: normal;
            }
            .category-filter option {
                padding: 8px;
                font-weight: normal;
            }
            /* Enhance sort icon visibility */
            .sort-icon {
                margin-left: 5px;
                font-size: 14px;
                opacity: 0.8;
                display: inline-block;
                transition: transform 0.2s;
            }
            .sortable {
                cursor: pointer;
                transition: background-color 0.2s;
            }
            .sortable:hover .sort-icon {
                opacity: 1;
            }
            /* Animation for sorting */
            .data-table tbody tr {
                transition: transform 0.2s, opacity 0.2s;
            }
            /* Improve dropdown usability */
            .category-filter:focus {
                outline: none;
                border-color: #1565c0;
                box-shadow: 0 0 0 2px rgba(21, 101, 192, 0.1);
            }
            /* Make table rows more readable */
            .data-table tbody tr:nth-child(even) {
                background-color: rgba(0, 0, 0, 0.02);
            }
            .data-table td {
                padding: 12px;
                border-bottom: 1px solid #eee;
                color: #666;
            }
            .data-table tr:hover {
                background: #f9f9f9;
            }
            .data-table td:last-child {
                text-transform: capitalize;
                font-weight: 500;
            }
            .data-table td:last-child {
                padding: 8px 12px;
                border-radius: 4px;
            }
            /* Category-specific colors */
            .data-table tr td:last-child:contains('rooms') {
                background-color: #e3f2fd;
                color: #1565c0;
            }
            .data-table tr td:last-child:contains('dining') {
                background-color: #f3e5f5;
                color: #7b1fa2;
            }
            .data-table tr td:last-child:contains('amenities') {
                background-color: #e8f5e9;
                color: #2e7d32;
            }
            .data-table tr td:last-child:contains('pricing') {
                background-color: #fff3e0;
                color: #e65100;
            }
            .data-table tr td:last-child:contains('location') {
                background-color: #e1f5fe;
                color: #0277bd;
            }
            .data-table tr td:last-child:contains('services') {
                background-color: #f1f8e9;
                color: #558b2f;
            }
            .data-table tr td:last-child:contains('events') {
                background-color: #fce4ec;
                color: #c2185b;
            }
            .data-table tr td:last-child:contains('policies') {
                background-color: #ede7f6;
                color: #4527a0;
            }
            .data-table tr td:last-child:contains('general') {
                background-color: #f5f5f5;
                color: #616161;
            }
            .no-data {
                text-align: center;
                padding: 40px;
                color: #666;
                font-style: italic;
            }
        `;
        document.head.appendChild(style);
    } catch (error) {
        console.error('Error loading chatbot data:', error);
        container.innerHTML = `<div class="error-message">Error loading chatbot inquiries: ${escapeHtml(error.message)}</div>`;
    }
}

// Helper function to escape HTML special characters
function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}
