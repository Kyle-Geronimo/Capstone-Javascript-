import { db, auth } from './firebase-config.js';
import { 
    collection, 
    getDocs, 
    addDoc, 
    query, 
    orderBy, 
    serverTimestamp,
    limit,
    onSnapshot,
    doc,
    deleteDoc,
    updateDoc
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

        // Static shell for the table; body will be updated in real time
        container.innerHTML = `
            <div class="chatbot-inquiries">
                <div class="chatbot-inquiries-header">
                    <h2>Chatbot Inquiries</h2>
                    <div class="chatbot-inquiries-actions">
                        <button type="button" class="chat-print-selected">Print selected</button>
                    </div>
                </div>
                <div class="table-container">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th style="width:32px;text-align:center;"><input type="checkbox" class="chat-select-all" aria-label="Select all conversations" /></th>
                                <th class="sortable" data-sort="time">
                                    Time
                                    <span class="sort-icon">↕</span>
                                </th>
                                <th>Question</th>
                                <th>Bot reply</th>
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
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
        `;

        const tbody = container.querySelector('tbody');
        const selectAllCheckbox = container.querySelector('.chat-select-all');
        const printSelectedBtn = container.querySelector('.chat-print-selected');
        // deleteSelectedBtn removed (no delete functionality, only print)
        const timeHeader = container.querySelector('th[data-sort="time"]');
        const categoryFilter = container.querySelector('.category-filter');
        let timeSort = 'desc'; // Start with newest first

        // View conversation modal (uses answer stored on the chatbot document)
        const openConversationModal = (questionText, answerText) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'chat-convo-backdrop';
            const hasAnswer = !!(answerText && answerText.trim());
            backdrop.innerHTML = `
                <div class="chat-convo-modal">
                    <div class="chat-convo-header">
                        <h3>Conversation</h3>
                        <button type="button" class="chat-convo-close" aria-label="Close">×</button>
                    </div>
                    <div class="chat-convo-body">
                        <div class="chat-convo-question"><strong>Question:</strong> <span>${escapeHtml(questionText)}</span></div>
                        <div class="chat-convo-responses">
                            ${hasAnswer
                                ? `<div class="chat-convo-entry">
                                       <div class="chat-convo-meta">Bot reply</div>
                                       <div class="chat-convo-text">${escapeHtml(answerText)}</div>
                                   </div>`
                                : '<p class="chat-convo-empty">No bot reply has been attached to this question yet.</p>'}
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(backdrop);

            const close = () => {
                backdrop.remove();
            };

            backdrop.addEventListener('click', (ev) => {
                if (ev.target === backdrop) close();
            });
            const closeBtn = backdrop.querySelector('.chat-convo-close');
            if (closeBtn) closeBtn.addEventListener('click', close);
        };

        // Helper: (re)wire row-level events
        const wireRowEvents = () => {
            const rows = container.querySelectorAll('tbody tr');
            rows.forEach(row => {
                const btn = row.querySelector('.chat-view-btn');
                const questionCell = row.querySelector('.inquiry-question');
                if (!btn || !questionCell) return;
                const questionText = questionCell.textContent || '';
                const answerText = row.dataset.answer || '';
                btn.onclick = () => {
                    if (!questionText) return;
                    openConversationModal(questionText, answerText);
                };
            });
        };

        // Time sorting (works on current rows)
        timeHeader.addEventListener('click', () => {
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
            wireRowEvents();
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

        // Select-all checkbox
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                const checked = e.target.checked;
                const boxes = container.querySelectorAll('.chat-select');
                boxes.forEach(box => { box.checked = checked; });
            });
        }

        // Helper: get selected row data
        const getSelectedRows = () => {
            const rows = Array.from(container.querySelectorAll('tbody tr'));
            return rows.filter(row => {
                const box = row.querySelector('.chat-select');
                return box && box.checked;
            });
        };

        // Delete functionality removed; conversations can only be printed now.

        // Print selected conversations
        if (printSelectedBtn) {
            printSelectedBtn.addEventListener('click', () => {
                const selectedRows = getSelectedRows();
                if (!selectedRows.length) {
                    alert('No conversations selected.');
                    return;
                }

                const items = selectedRows.map(row => {
                    const timeText = row.querySelector('td:nth-child(2)')?.textContent || '';
                    const questionText = row.querySelector('.inquiry-question')?.textContent || '';
                    // Read the full answer from the row dataset so the table cell can stay hidden
                    const answerText = row.dataset.answer || '';
                    const categoryText = row.querySelector('td[data-category]')?.textContent || '';
                    return { timeText, questionText, answerText, categoryText };
                });

                const win = window.open('', '_blank');
                if (!win) return;
                win.document.write(`<!DOCTYPE html><html><head><title>Chatbot Conversations</title>
                    <style>
                        body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
                        h1 { font-size: 1.4rem; margin-bottom: 12px; }
                        .conv { margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #e5e7eb; }
                        .meta { font-size: 0.8rem; color: #6b7280; margin-bottom: 4px; }
                        .q { font-weight: 600; margin-bottom: 4px; }
                        .a { white-space: pre-wrap; }
                    </style>
                </head><body>
                    <h1>Chatbot Conversations</h1>
                    ${items.map(item => `
                        <div class="conv">
                            <div class="meta">${item.timeText} · ${item.categoryText}</div>
                            <div class="q">Q: ${item.questionText}</div>
                            <div class="a">A: ${item.answerText}</div>
                        </div>
                    `).join('')}
                </body></html>`);
                win.document.close();
                win.focus();
                win.print();
            });
        }

        // Realtime listener for chatbot inquiries
        const inquiriesQuery = query(
            collection(db, 'chatbot'),
            orderBy('timestamp', 'desc'),
            limit(100)
        );

        onSnapshot(inquiriesQuery, (snap) => {
            if (snap.empty) {
                tbody.innerHTML = "<tr><td colspan='6'><div class='no-data'>No chatbot inquiries available.</div></td></tr>";
                return;
            }

            const rowsHtml = snap.docs.map(doc => {
                const inquiry = doc.data() || {};
                const timestamp = inquiry.timestamp?.toDate ? inquiry.timestamp.toDate() : new Date();
                const categorySafe = escapeHtml(inquiry.category || 'general');
                const questionSafe = escapeHtml(inquiry.question || '');
                const answerSafe = escapeHtml(inquiry.answer || '');
                return `
                    <tr data-id="${doc.id}" data-timestamp="${timestamp.getTime()}" data-category="${categorySafe}" data-answer="${answerSafe}">
                        <td style="text-align:center;"><input type="checkbox" class="chat-select" aria-label="Select conversation" /></td>
                        <td>${timestamp.toLocaleString()}</td>
                        <td class="inquiry-question">${questionSafe}</td>
                        <td class="inquiry-answer"><span class="muted">(hidden - click View)</span></td>
                        <td data-category="${categorySafe}">${categorySafe}</td>
                        <td>
                            <button type="button" class="chat-view-btn">View conversation</button>
                        </td>
                    </tr>
                `;
            }).join('');

            tbody.innerHTML = rowsHtml;
            wireRowEvents();
        }, (error) => {
            console.error('Error loading chatbot inquiries realtime:', error);
            tbody.innerHTML = `<tr><td colspan='6'><div class="error-message">Error loading chatbot inquiries: ${escapeHtml(error.message)}</div></td></tr>`;
        });

        // Add some basic styling
        const style = document.createElement('style');
        style.textContent = `
            .chatbot-page {
                min-height: 100vh;
                background: radial-gradient(circle at top, #dbeafe 0, #eff6ff 28%, #f9fafb 60%, #f9fafb 100%);
            }
            .dashboard-analytics-row {
                max-width: 1180px;
                margin: 24px auto 8px auto;
                padding: 0 16px;
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
                gap: 16px;
            }
            .chatbot-analytics-section {
                margin: 0;
            }
            .chatbot-analytics {
                display: flex;
                justify-content: center;
                align-items: stretch;
            }
            .analytics-card {
                width: 100%;
                max-width: 1180px;
                background: #ffffff;
                border-radius: 18px;
                padding: 20px 24px 18px 24px;
                box-shadow: 0 18px 45px rgba(15, 23, 42, 0.16);
                border: 1px solid rgba(148, 163, 184, 0.5);
            }
            .analytics-header {
                display: flex;
                flex-direction: row;
                justify-content: space-between;
                align-items: baseline;
                gap: 10px;
                margin-bottom: 14px;
            }
            .analytics-header h2 {
                margin: 0;
                font-size: 1.25rem;
                font-weight: 600;
                color: #0f172a;
            }
            .analytics-subtitle {
                margin: 0;
                font-size: 0.85rem;
                color: #64748b;
            }
            .analytics-metric {
                display: inline-flex;
                align-items: baseline;
                gap: 8px;
                margin-bottom: 10px;
                padding: 8px 14px;
                border-radius: 999px;
                background: radial-gradient(circle at top left, #e0f2fe, #eef2ff);
            }
            .analytics-label {
                font-size: 0.78rem;
                text-transform: uppercase;
                letter-spacing: 0.09em;
                font-weight: 600;
                color: #0f172a;
            }
            .analytics-value {
                font-size: 1.4rem;
                font-weight: 700;
                color: #0f172a;
            }
            .analytics-categories {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-top: 6px;
            }
            .analytics-category-row {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .analytics-category-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 0.85rem;
            }
            .analytics-category-name {
                text-transform: capitalize;
                color: #0f172a;
                font-weight: 500;
            }
            .analytics-category-count {
                font-variant-numeric: tabular-nums;
                color: #64748b;
                font-size: 0.8rem;
            }
            .analytics-bar {
                width: 100%;
                height: 6px;
                border-radius: 999px;
                background: #e5e7eb;
                overflow: hidden;
            }
            .analytics-bar-fill {
                height: 100%;
                border-radius: 999px;
                background: linear-gradient(90deg, #0ea5e9, #6366f1);
                transition: width 0.35s ease-out;
            }
            /* Category-specific bar colors */
            .analytics-bar-fill--rooms { background: linear-gradient(90deg, #3b82f6, #1d4ed8); }
            .analytics-bar-fill--dining { background: linear-gradient(90deg, #ec4899, #db2777); }
            .analytics-bar-fill--amenities { background: linear-gradient(90deg, #22c55e, #15803d); }
            .analytics-bar-fill--pricing { background: linear-gradient(90deg, #f97316, #c2410c); }
            .analytics-bar-fill--location { background: linear-gradient(90deg, #06b6d4, #0e7490); }
            .analytics-bar-fill--services { background: linear-gradient(90deg, #a855f7, #7e22ce); }
            .analytics-bar-fill--events { background: linear-gradient(90deg, #facc15, #eab308); }
            .analytics-bar-fill--policies { background: linear-gradient(90deg, #6366f1, #4f46e5); }
            .analytics-bar-fill--general { background: linear-gradient(90deg, #9ca3af, #4b5563); }

            /* Filters */
            .analytics-filters {
                display: inline-flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-bottom: 10px;
            }
            .analytics-filter {
                border-radius: 999px;
                border: 1px solid #e5e7eb;
                background: #f9fafb;
                padding: 4px 10px;
                font-size: 0.78rem;
                color: #4b5563;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
            }
            .analytics-filter:hover {
                background: #e5f2ff;
                border-color: #bfdbfe;
            }
            .analytics-filter.is-active {
                background: #0ea5e9;
                border-color: #0ea5e9;
                color: #ffffff;
            }
            .analytics-users-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 10px;
                margin-top: 8px;
            }
            .analytics-user-card {
                padding: 10px 12px;
                border-radius: 12px;
                background: #f9fafb;
                border: 1px solid #e5e7eb;
            }
            .analytics-user-label {
                font-size: 0.78rem;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #6b7280;
            }
            .analytics-user-value {
                margin-top: 4px;
                font-size: 1.25rem;
                font-weight: 600;
                color: #111827;
            }
            .analytics-user-sub {
                margin-top: 2px;
                font-size: 0.75rem;
                color: #9ca3af;
            }
            .analytics-footnote {
                margin-top: 10px;
                font-size: 0.74rem;
                color: #9ca3af;
            }
            .visitors-chart {
                margin-top: 14px;
                padding-top: 8px;
                border-top: 1px dashed #e5e7eb;
            }
            .visitors-chart-header {
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                margin-bottom: 8px;
            }
            .visitors-chart-title {
                font-size: 0.85rem;
                font-weight: 600;
                color: #0f172a;
            }
            .visitors-chart-subtitle {
                font-size: 0.75rem;
                color: #9ca3af;
            }
            .visitors-chart-bars {
                display: grid;
                grid-template-columns: repeat(12, minmax(0, 1fr));
                gap: 4px;
                align-items: flex-end;
            }
            .visitors-bar {
                position: relative;
                height: 70px;
                border-radius: 999px;
                background: #e5e7eb;
                overflow: hidden;
            }
            .visitors-bar-fill {
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                border-radius: 999px;
                background: linear-gradient(180deg, #22c55e, #16a34a);
                transition: height 0.3s ease-out;
            }
            .visitors-bar-label {
                margin-top: 3px;
                text-align: center;
                font-size: 0.7rem;
                color: #9ca3af;
            }
            @media (max-width: 640px) {
                .analytics-card {
                    padding: 16px 16px 14px 16px;
                }
                .analytics-header {
                    flex-direction: column;
                    align-items: flex-start;
                }
            }
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
            .chatbot-inquiries-header {
                display:flex;
                justify-content:space-between;
                align-items:center;
                gap:12px;
                margin-bottom:10px;
            }
            .chatbot-inquiries-actions {
                display:flex;
                gap:8px;
            }
            .chatbot-inquiries-actions button {
                padding:6px 10px;
                border-radius:999px;
                border:1px solid #e5e7eb;
                background:#f9fafb;
                font-size:0.8rem;
                cursor:pointer;
            }
            .chatbot-inquiries-actions button:hover {
                background:#e0f2fe;
                border-color:#bfdbfe;
            }
            .chat-view-btn {
                padding: 6px 10px;
                border-radius: 999px;
                border: 1px solid #e5e7eb;
                background: #f9fafb;
                font-size: 0.8rem;
                color: #1f2937;
                cursor: pointer;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
                white-space: nowrap;
            }
            .chat-view-btn:hover {
                background: #e0f2fe;
                border-color: #bfdbfe;
                color: #0f172a;
            }
            .chat-convo-backdrop {
                position: fixed;
                inset: 0;
                background: rgba(15,23,42,0.45);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1200;
            }
            .chat-convo-modal {
                width: 100%;
                max-width: 720px;
                background: #ffffff;
                border-radius: 16px;
                box-shadow: 0 25px 80px rgba(15,23,42,0.4);
                border: 1px solid rgba(148,163,184,0.5);
                padding: 16px 18px 18px 18px;
            }
            .chat-convo-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 8px;
            }
            .chat-convo-header h3 {
                margin: 0;
                font-size: 1.05rem;
                font-weight: 600;
                color: #0f172a;
            }
            .chat-convo-close {
                border-radius: 999px;
                border: 1px solid #e5e7eb;
                background: #f9fafb;
                width: 28px;
                height: 28px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                font-size: 1rem;
                line-height: 1;
            }
            .chat-convo-body {
                max-height: 420px;
                overflow-y: auto;
                padding-top: 4px;
            }
            .chat-convo-question {
                font-size: 0.9rem;
                color: #374151;
                margin-bottom: 10px;
            }
            .chat-convo-question span {
                display: inline-block;
                margin-left: 4px;
            }
            .chat-convo-responses {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .chat-convo-loading {
                font-size: 0.88rem;
                color: #6b7280;
            }
            .chat-convo-empty {
                font-size: 0.88rem;
                color: #6b7280;
            }
            .chat-convo-entry {
                padding: 10px 12px;
                border-radius: 10px;
                background: #f9fafb;
                border: 1px solid #e5e7eb;
            }
            .chat-convo-meta {
                font-size: 0.78rem;
                color: #6b7280;
                margin-bottom: 4px;
            }
            .chat-convo-text {
                font-size: 0.9rem;
                color: #111827;
                white-space: pre-wrap;
            }
        `;
        document.head.appendChild(style);
    } catch (error) {
        console.error('Error loading chatbot data:', error);
        container.innerHTML = `<div class="error-message">Error loading chatbot inquiries: ${escapeHtml(error.message)}</div>`;
    }
}

// Real-time analytics: total inquiries and per-category counts with time filters
export function initChatbotAnalyticsRealtime() {
    const analyticsEl = document.getElementById('chatbot-analytics');
    if (!analyticsEl) return;

    if (!auth.currentUser) {
        analyticsEl.innerHTML = '<div class="auth-message"><p>Please log in to view chatbot analytics.</p></div>';
        return;
    }

    const inquiriesQuery = query(
        collection(db, 'chatbot'),
        orderBy('timestamp', 'desc'),
        limit(500)
    );

    let cachedEntries = [];
    let currentRange = 'all'; // 'all' | '24h' | '7d'

    const render = () => {
        if (!cachedEntries.length) {
            analyticsEl.innerHTML = '<div class="no-data">No chatbot inquiries yet.</div>';
            return;
        }

        const now = Date.now();
        const ms24h = 24 * 60 * 60 * 1000;
        const ms7d = 7 * ms24h;

        let filtered = cachedEntries;
        if (currentRange === '24h') {
            filtered = cachedEntries.filter(e => now - e.timeMs <= ms24h);
        } else if (currentRange === '7d') {
            filtered = cachedEntries.filter(e => now - e.timeMs <= ms7d);
        }

        if (!filtered.length) {
            analyticsEl.innerHTML = '<div class="no-data">No inquiries in this time range.</div>';
            return;
        }

        const countsByCategory = {};
        let total = 0;

        filtered.forEach((entry) => {
            const cat = entry.category || 'general';
            countsByCategory[cat] = (countsByCategory[cat] || 0) + 1;
            total += 1;
        });

        const sortedCategories = Object.entries(countsByCategory).sort((a, b) => b[1] - a[1]);

        analyticsEl.innerHTML = `
            <div class="analytics-card">
                <div class="analytics-header">
                    <h2>Chatbot Analytics</h2>
                    <p class="analytics-subtitle">Real-time summary of customer inquiries by category</p>
                </div>
                <div class="analytics-metric">
                    <span class="analytics-label">Total inquiries</span>
                    <span class="analytics-value">${total}</span>
                </div>
                <div class="analytics-filters">
                    <button type="button" class="analytics-filter ${currentRange === 'all' ? 'is-active' : ''}" data-range="all">All (last 500)</button>
                    <button type="button" class="analytics-filter ${currentRange === '24h' ? 'is-active' : ''}" data-range="24h">Last 24h</button>
                    <button type="button" class="analytics-filter ${currentRange === '7d' ? 'is-active' : ''}" data-range="7d">Last 7 days</button>
                </div>
                <div class="analytics-categories">
                    ${sortedCategories.map(([cat, count]) => {
                        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                        const safeCat = escapeHtml(cat);
                        return `
                            <div class="analytics-category-row">
                                <div class="analytics-category-header">
                                    <span class="analytics-category-name">${safeCat}</span>
                                    <span class="analytics-category-count">${count} (${pct}%)</span>
                                </div>
                                <div class="analytics-bar">
                                    <div class="analytics-bar-fill analytics-bar-fill--${safeCat}" style="width: ${pct}%;"></div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;

        const buttons = analyticsEl.querySelectorAll('.analytics-filter');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                const range = btn.getAttribute('data-range') || 'all';
                currentRange = range;
                render();
            });
        });
    };

    onSnapshot(
        inquiriesQuery,
        (snap) => {
            if (snap.empty) {
                cachedEntries = [];
                render();
                return;
            }

            cachedEntries = [];
            snap.forEach((doc) => {
                const data = doc.data() || {};
                const ts = data.timestamp?.toDate ? data.timestamp.toDate() : new Date();
                cachedEntries.push({
                    category: data.category || 'general',
                    timeMs: ts.getTime()
                });
            });

            render();
        },
        (error) => {
            console.error('Error loading chatbot analytics:', error);
            analyticsEl.innerHTML = `<div class="error-message">Error loading chatbot analytics: ${escapeHtml(error.message)}</div>`;
        }
    );
}

// Real-time account analytics: total and active admins/employees
export function initAccountAnalyticsRealtime() {
    const el = document.getElementById('account-analytics');
    if (!el) return;

    if (!auth.currentUser) {
        el.innerHTML = '<div class="auth-message"><p>Please log in to view account analytics.</p></div>';
        return;
    }

    const usersCol = collection(db, 'users');
    const visitsQuery = query(
        collection(db, 'visits'),
        orderBy('ts', 'desc'),
        limit(500)
    );

    const rolesByUid = {};
    const lastVisitByUid = {};
    let recentVisits = []; // raw visits with timestamp (ms) for chart
    const ACTIVE_MS = 15 * 60 * 1000; // 15 minutes

    const renderAccounts = () => {
        const now = Date.now();
        let totalAdmins = 0;
        let totalEmployees = 0;
        let activeAdmins = 0;
        let activeEmployees = 0;

        Object.entries(rolesByUid).forEach(([uid, role]) => {
            if (role === 'admin') totalAdmins += 1;
            else totalEmployees += 1;

            const last = lastVisitByUid[uid];
            if (!last) return;

            const isActive = now - last <= ACTIVE_MS;
            if (!isActive) return;

            if (role === 'admin') activeAdmins += 1;
            else activeEmployees += 1;
        });

        el.innerHTML = `
            <div class="analytics-card">
                <div class="analytics-header">
                    <h2>Account Overview</h2>
                    <p class="analytics-subtitle">Real-time snapshot of admin and employee accounts</p>
                </div>
                <div class="analytics-users-grid">
                    <div class="analytics-user-card">
                        <div class="analytics-user-label">Total admins</div>
                        <div class="analytics-user-value">${totalAdmins}</div>
                        <div class="analytics-user-sub">All admin accounts in the system</div>
                    </div>
                    <div class="analytics-user-card">
                        <div class="analytics-user-label">Total employees</div>
                        <div class="analytics-user-value">${totalEmployees}</div>
                        <div class="analytics-user-sub">All employee accounts in the system</div>
                    </div>
                    <div class="analytics-user-card">
                        <div class="analytics-user-label">Active admins</div>
                        <div class="analytics-user-value">${activeAdmins}</div>
                        <div class="analytics-user-sub">Seen in the last 15 minutes</div>
                    </div>
                    <div class="analytics-user-card">
                        <div class="analytics-user-label">Active employees</div>
                        <div class="analytics-user-value">${activeEmployees}</div>
                        <div class="analytics-user-sub">Seen in the last 15 minutes</div>
                    </div>
                </div>
                <p class="analytics-footnote">Active users are counted based on recent activity across the system (last 15 minutes).</p>
            </div>
        `;
    };

    const unsubUsers = onSnapshot(
        usersCol,
        (snap) => {
            // reset map
            Object.keys(rolesByUid).forEach(k => delete rolesByUid[k]);
            snap.forEach((docSnap) => {
                const data = docSnap.data() || {};
                const role = data.role || 'employee';
                rolesByUid[docSnap.id] = role;
            });
            renderAccounts();
        },
        (error) => {
            console.error('Error loading users for account analytics:', error);
            el.innerHTML = `<div class="error-message">Error loading account analytics: ${escapeHtml(error.message)}</div>`;
        }
    );

    const unsubVisits = onSnapshot(
        visitsQuery,
        (snap) => {
            // keep latest visit timestamp per uid (for active users)
            // and all visits (including anonymous) for the chart
            Object.keys(lastVisitByUid).forEach(k => delete lastVisitByUid[k]);
            recentVisits = [];
            snap.forEach((d) => {
                const v = d.data() || {};
                if (!v.ts) return;
                const tsDate = v.ts.toDate ? v.ts.toDate() : null;
                if (!tsDate) return;
                const ms = tsDate.getTime();

                const uid = v.uid;
                if (uid) {
                    if (!lastVisitByUid[uid] || ms > lastVisitByUid[uid]) {
                        lastVisitByUid[uid] = ms;
                    }
                }

                // Always count visit in chart, even without uid (public visitors)
                recentVisits.push({ timeMs: ms });
            });
            renderAccounts();
        },
        (error) => {
            console.error('Error loading visits for account analytics:', error);
            // Do not overwrite card completely; just log the error.
        }
    );

    return () => {
        if (typeof unsubUsers === 'function') unsubUsers();
        if (typeof unsubVisits === 'function') unsubVisits();
    };
}

// -----------------------------
// Reservation dashboard (Guest Records + Reports & Analytics)
// -----------------------------
export function initReservationDashboard() {
    const root = document.getElementById('reservation-dashboard');
    if (!root) return;

    if (!auth.currentUser) {
        root.innerHTML = '<div class="auth-message"><p>Please log in to manage guest records.</p></div>';
        return;
    }

    root.innerHTML = `
        <section class="guest-dashboard">
            <div class="guest-header">
                <div>
                    <h2>Guest Records</h2>
                    <p class="guest-subtitle">Manage in-house guests, reservations, and history.</p>
                </div>
                <div class="guest-summary-row">
                    <div class="guest-summary-card"><div class="guest-summary-label">Total guests</div><div class="guest-summary-value" id="guestTotalCount">0</div></div>
                    <div class="guest-summary-card"><div class="guest-summary-label">Currently in-house</div><div class="guest-summary-value" id="guestInHouseCount">0</div></div>
                    <div class="guest-summary-card"><div class="guest-summary-label">Checked out</div><div class="guest-summary-value" id="guestCheckedOutCount">0</div></div>
                    <div class="guest-summary-card"><div class="guest-summary-label">Upcoming arrivals</div><div class="guest-summary-value" id="guestUpcomingCount">0</div></div>
                </div>
            </div>

            <div class="guest-card">
                <h3>Add / Update Guest</h3>
                <form id="guestForm" class="guest-form">
                    <input type="hidden" id="reservationId" />
                    <div class="guest-form-row">
                        <div class="guest-form-group"><label for="guestName">Guest name</label><input type="text" id="guestName" placeholder="e.g. Juan Dela Cruz" required /></div>
                        <div class="guest-form-group"><label for="guestRoom">Room</label><input type="text" id="guestRoom" placeholder="e.g. 203" required /></div>
                        <div class="guest-form-group"><label for="guestStatus">Status</label><select id="guestStatus" required><option value="in-house">In-house</option><option value="reserved">Reserved</option><option value="checked-out">Checked out</option></select></div>
                    </div>
                    <div class="guest-form-row">
                        <div class="guest-form-group"><label for="guestCheckIn">Check-in date</label><input type="date" id="guestCheckIn" required /></div>
                        <div class="guest-form-group"><label for="guestCheckOut">Check-out date</label><input type="date" id="guestCheckOut" required /></div>
                        <div class="guest-form-group"><label for="guestHotel">Hotel</label>
                            <select id="guestHotel" required>
                                <option value="D'Mariners Inn Hotel">D'Mariners Inn Hotel</option>
                                <option value="Wennrod Hotel">Wennrod Hotel</option>
                                <option value="Bicotels Hotel">Bicotels Hotel</option>
                            </select>
                        </div>
                    </div>
                    <div class="guest-form-actions"><button type="button" id="guestResetBtn" class="action-btn secondary">Clear</button><button type="submit" class="action-btn primary">Save Guest</button></div>
                </form>
            </div>

            <div class="guest-card">
                <div class="guest-card-header">
                    <div>
                        <h3>Guest List</h3>
                        <p class="guest-card-sub">View and manage current reservations.</p>
                    </div>
                    <div class="guest-filters">
                        <select id="guestStatusFilter" class="guest-filter-input">
                            <option value="all">All status</option>
                            <option value="in-house">In-house</option>
                            <option value="reserved">Reserved</option>
                            <option value="checked-out">Checked out</option>
                        </select>
                        <input type="date" id="guestFromDate" class="guest-filter-input" />
                        <input type="date" id="guestToDate" class="guest-filter-input" />
                        <input type="text" id="guestSearch" class="guest-filter-input" placeholder="Search by guest or room..." />
                    </div>
                </div>
                <div id="guestMessage" class="guest-message" aria-live="polite"></div>
                <div class="table-container">
                    <table class="data-table guest-table">
                        <thead>
                            <tr>
                                <th>Guest Name</th>
                                <th>Hotel</th>
                                <th>Room</th>
                                <th>Check-in</th>
                                <th>Check-out</th>
                                <th>Status</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody id="guestTableBody"></tbody>
                    </table>
                    <div id="guestPagination"></div>
                </div>
            </div>
        </section>

        <!-- Centered delete confirmation modal -->
        <div id="guestDeleteModal" class="guest-delete-modal-overlay" hidden>
            <div class="guest-delete-modal">
                <h4 class="guest-delete-title">Delete reservation</h4>
                <p class="guest-delete-text" id="guestDeleteText">Delete this reservation?</p>
                <div class="guest-delete-actions">
                    <button type="button" id="guestDeleteConfirm" class="guest-message-btn guest-message-btn--danger">Delete</button>
                    <button type="button" id="guestDeleteCancel" class="guest-message-btn">Cancel</button>
                </div>
            </div>
        </div>
    `;

    const reservationsCol = collection(db, 'guestReservations');
    const reservationsQuery = query(reservationsCol, orderBy('checkIn', 'desc'), limit(200));

    const guestStatusFilter = document.getElementById('guestStatusFilter');
    const guestFromDate = document.getElementById('guestFromDate');
    const guestToDate = document.getElementById('guestToDate');
    const guestSearch = document.getElementById('guestSearch');
    const guestTableBody = document.getElementById('guestTableBody');
    const guestPagination = document.getElementById('guestPagination');

    const guestForm = document.getElementById('guestForm');
    const reservationIdInput = document.getElementById('reservationId');
    const guestNameInput = document.getElementById('guestName');
    const guestRoomInput = document.getElementById('guestRoom');
    const guestCheckInInput = document.getElementById('guestCheckIn');
    const guestCheckOutInput = document.getElementById('guestCheckOut');
    const guestHotelInput = document.getElementById('guestHotel');
    const guestStatusInput = document.getElementById('guestStatus');
    const guestResetBtn = document.getElementById('guestResetBtn');

    const totalEl = document.getElementById('guestTotalCount');
    const inHouseEl = document.getElementById('guestInHouseCount');
    const checkedOutEl = document.getElementById('guestCheckedOutCount');
    const upcomingEl = document.getElementById('guestUpcomingCount');

    let reservations = [];
    let showingAllGuests = false;

    const guestMessageEl = document.getElementById('guestMessage');

    const deleteModal = document.getElementById('guestDeleteModal');
    const deleteTextEl = document.getElementById('guestDeleteText');
    const deleteConfirmBtn = document.getElementById('guestDeleteConfirm');
    const deleteCancelBtn = document.getElementById('guestDeleteCancel');
    let pendingDeleteId = null;

    const setGuestMessage = (text, type = 'info') => {
        if (!guestMessageEl) return;
        if (!text) {
            guestMessageEl.textContent = '';
            guestMessageEl.className = 'guest-message';
            return;
        }
        guestMessageEl.textContent = text;
        guestMessageEl.className = `guest-message guest-message--${type}`;
    };

    const openDeleteModal = (reservationId, displayName) => {
        if (!deleteModal || !deleteTextEl) return;
        pendingDeleteId = reservationId;
        const safeName = escapeHtml(displayName || 'this reservation');
        deleteTextEl.innerHTML = `Delete <strong>${safeName}</strong>?`;
        deleteModal.hidden = false;
        deleteModal.classList.add('is-open');
    };

    const closeDeleteModal = () => {
        if (!deleteModal) return;
        deleteModal.hidden = true;
        deleteModal.classList.remove('is-open');
        pendingDeleteId = null;
    };

    deleteCancelBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        closeDeleteModal();
    });

    deleteConfirmBtn?.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!pendingDeleteId) {
            closeDeleteModal();
            return;
        }
        try {
            await deleteDoc(doc(db, 'guestReservations', pendingDeleteId));
            setGuestMessage('Reservation deleted successfully.', 'success');
        } catch (err) {
            console.error('Failed to delete reservation', err);
            setGuestMessage('Failed to delete reservation. Please try again.', 'error');
        } finally {
            closeDeleteModal();
        }
    });

    const asDateOnly = (val) => {
        if (!val) return null;
        const d = val.toDate ? val.toDate() : (val instanceof Date ? val : new Date(val));
        if (isNaN(d.getTime())) return null;
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    };

    const fmtDate = (d) => (d ? d.toISOString().slice(0, 10) : '');

    const statusBadgeClass = (s) => {
        if (s === 'in-house') return 'status-badge status-inhouse';
        if (s === 'reserved') return 'status-badge status-reserved';
        if (s === 'checked-out') return 'status-badge status-checkedout';
        return 'status-badge';
    };

    const recomputeSummary = () => {
        const today = new Date();
        const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        let total = reservations.length;
        let inHouse = 0;
        let checked = 0;
        let upcoming = 0;
        reservations.forEach(r => {
            const status = r.status || 'reserved';
            const ci = asDateOnly(r.checkIn);
            if (status === 'in-house') inHouse++;
            if (status === 'checked-out') checked++;
            if (status === 'reserved' && ci && ci >= todayOnly) upcoming++;
        });
        if (totalEl) totalEl.textContent = String(total);
        if (inHouseEl) inHouseEl.textContent = String(inHouse);
        if (checkedOutEl) checkedOutEl.textContent = String(checked);
        if (upcomingEl) upcomingEl.textContent = String(upcoming);
    };

    const renderGuestTable = () => {
        if (!guestTableBody) return;
        const statusFilter = guestStatusFilter?.value || 'all';
        const fromVal = guestFromDate?.value || '';
        const toVal = guestToDate?.value || '';
        const searchVal = (guestSearch?.value || '').toLowerCase();
        const fromD = fromVal ? new Date(fromVal + 'T00:00:00') : null;
        const toD = toVal ? new Date(toVal + 'T23:59:59') : null;

        const filtered = reservations.filter(r => {
            if (statusFilter !== 'all' && (r.status || '') !== statusFilter) return false;
            const ci = asDateOnly(r.checkIn);
            if (fromD && ci && ci < fromD) return false;
            if (toD && ci && ci > toD) return false;
            if (searchVal) {
                const n = (r.guestName || '').toLowerCase();
                const rm = (r.room || '').toLowerCase();
                const h = (r.hotel || '').toLowerCase();
                if (!n.includes(searchVal) && !rm.includes(searchVal) && !h.includes(searchVal)) return false;
            }
            return true;
        });

        const shouldPaginate = filtered.length > 5;
        const rowsToRender = (!shouldPaginate || showingAllGuests) ? filtered : filtered.slice(0, 5);

        if (!rowsToRender.length) {
            guestTableBody.innerHTML = `<tr><td colspan="7"><div class="no-data">No reservations found for the selected filters.</div></td></tr>`;
            if (guestPagination) guestPagination.innerHTML = '';
            return;
        }

        guestTableBody.innerHTML = rowsToRender.map(r => {
            const ci = fmtDate(asDateOnly(r.checkIn));
            const co = fmtDate(asDateOnly(r.checkOut));
            const st = r.status || 'reserved';
            return `
                <tr data-id="${r.id}">
                    <td>${escapeHtml(r.guestName || '')}</td>
                    <td>${escapeHtml(r.hotel || '')}</td>
                    <td>${escapeHtml(r.room || '')}</td>
                    <td>${escapeHtml(ci)}</td>
                    <td>${escapeHtml(co)}</td>
                    <td><span class="${statusBadgeClass(st)}">${escapeHtml(st)}</span></td>
                    <td>
                        <button type="button" class="guest-edit-btn">Edit</button>
                        <button type="button" class="guest-delete-btn">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

        if (guestPagination) {
            guestPagination.innerHTML = '';
            if (shouldPaginate && !showingAllGuests) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'action-btn secondary';
                btn.textContent = 'View all';
                btn.addEventListener('click', () => {
                    showingAllGuests = true;
                    renderGuestTable();
                });
                guestPagination.appendChild(btn);
            } else if (shouldPaginate && showingAllGuests) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'action-btn secondary';
                btn.textContent = 'View less';
                btn.addEventListener('click', () => {
                    showingAllGuests = false;
                    renderGuestTable();
                });
                guestPagination.appendChild(btn);
            }
        }

        guestTableBody.querySelectorAll('.guest-edit-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const tr = ev.currentTarget.closest('tr');
                const id = tr?.getAttribute('data-id');
                const rec = reservations.find(r => r.id === id);
                if (!rec) return;
                reservationIdInput.value = rec.id;
                guestNameInput.value = rec.guestName || '';
                guestRoomInput.value = rec.room || '';
                guestCheckInInput.value = fmtDate(asDateOnly(rec.checkIn));
                guestCheckOutInput.value = fmtDate(asDateOnly(rec.checkOut));
                if (guestHotelInput) guestHotelInput.value = rec.hotel || "D'Mariners Inn Hotel";
                guestStatusInput.value = rec.status || 'reserved';
            });
        });

        guestTableBody.querySelectorAll('.guest-delete-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                const tr = ev.currentTarget.closest('tr');
                const id = tr?.getAttribute('data-id');
                if (!id) return;
                const rec = reservations.find(r => r.id === id);
                openDeleteModal(id, rec?.guestName || 'this reservation');
            });
        });
    };

    const clearForm = () => {
        reservationIdInput.value = '';
        guestNameInput.value = '';
        guestRoomInput.value = '';
        guestCheckInInput.value = '';
        guestCheckOutInput.value = '';
        if (guestHotelInput) guestHotelInput.value = "D'Mariners Inn Hotel";
        guestStatusInput.value = 'in-house';
    };

    guestResetBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        clearForm();
    });

    guestForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = guestNameInput.value.trim();
        const room = guestRoomInput.value.trim();
        const ciVal = guestCheckInInput.value;
        const coVal = guestCheckOutInput.value;
        const hotel = guestHotelInput?.value || "D'Mariners Inn Hotel";
        const status = guestStatusInput.value;
        if (!name || !room || !ciVal || !coVal || !hotel) {
            setGuestMessage('Please fill in all required fields before saving.', 'error');
            return;
        }
        const ci = new Date(ciVal + 'T12:00:00');
        const co = new Date(coVal + 'T12:00:00');
        if (co < ci) {
            setGuestMessage('Check-out date cannot be before check-in date.', 'error');
            return;
        }
        const payload = {
            guestName: name,
            room,
            checkIn: ci,
            checkOut: co,
            hotel,
            status,
            updatedAt: serverTimestamp(),
            userId: auth.currentUser?.uid || null
        };
        const existing = reservationIdInput.value;
        try {
            if (existing) {
                await updateDoc(doc(db, 'guestReservations', existing), payload);
                setGuestMessage('Guest reservation updated.', 'success');
            } else {
                await addDoc(reservationsCol, { ...payload, createdAt: serverTimestamp() });
                setGuestMessage('Guest reservation added.', 'success');
            }
            clearForm();
        } catch (err) {
            console.error('Failed to save reservation', err);
            setGuestMessage('Failed to save reservation. Please try again.', 'error');
        }
    });

    const resetPaginationAndRender = () => {
        showingAllGuests = false;
        renderGuestTable();
    };

    guestStatusFilter?.addEventListener('change', resetPaginationAndRender);
    guestFromDate?.addEventListener('change', resetPaginationAndRender);
    guestToDate?.addEventListener('change', resetPaginationAndRender);
    guestSearch?.addEventListener('input', resetPaginationAndRender);

    onSnapshot(reservationsQuery, (snap) => {
        reservations = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
        showingAllGuests = false;
        recomputeSummary();
        renderGuestTable();
    }, (err) => {
        console.error('Error loading guest reservations', err);
        if (guestTableBody) {
            guestTableBody.innerHTML = `<tr><td colspan="6"><div class="error-message">Error loading guest reservations: ${escapeHtml(err.message)}</div></td></tr>`;
        }
    });
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
