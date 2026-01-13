/* ============================================
   HotelLink Animation Controller v2
   - Safe animations that don't hide content
   - Scroll-triggered enhancements
   ============================================ */

(function() {
  'use strict';

  // Wait for page to fully load
  window.addEventListener('load', function() {
    
    // Small delay to ensure everything is rendered
    setTimeout(initAnimations, 300);
    
  });

  function initAnimations() {
    
    // ============================================
    // SCROLL-TRIGGERED SLIDE-UP FOR HOTEL CARDS
    // ============================================
    
    const hotelCards = document.querySelectorAll('.hotel-gallery-card');
    
    if (hotelCards.length > 0 && 'IntersectionObserver' in window) {
      
      // First, mark cards as ready for animation
      hotelCards.forEach((card, index) => {
        card.classList.add('will-animate');
        card.style.transitionDelay = (index * 0.15) + 's';
      });
      
      // Create observer
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('animated');
            observer.unobserve(entry.target);
          }
        });
      }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
      });
      
      // Start observing
      hotelCards.forEach(card => observer.observe(card));
    }

    // ============================================
    // BUTTON RIPPLE EFFECT
    // ============================================
    
    const buttons = document.querySelectorAll('.link-btn, .action-btn.primary, .see-more-btn');
    
    buttons.forEach(button => {
      button.addEventListener('click', function(e) {
        // Create ripple
        const ripple = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;
        
        ripple.style.cssText = `
          position: absolute;
          width: ${size}px;
          height: ${size}px;
          left: ${x}px;
          top: ${y}px;
          background: rgba(255, 255, 255, 0.4);
          border-radius: 50%;
          transform: scale(0);
          animation: ripple-effect 0.6s ease-out forwards;
          pointer-events: none;
        `;
        
        this.style.position = 'relative';
        this.style.overflow = 'hidden';
        this.appendChild(ripple);
        
        setTimeout(() => ripple.remove(), 600);
      });
    });

    // Add ripple keyframes
    if (!document.getElementById('hotellink-animations-style')) {
      const style = document.createElement('style');
      style.id = 'hotellink-animations-style';
      style.textContent = `
        @keyframes ripple-effect {
          to {
            transform: scale(4);
            opacity: 0;
          }
        }
      `;
      document.head.appendChild(style);
    }

    // ============================================
    // QUICKLINK HOVER ENHANCEMENT
    // ============================================
    
    const quicklinks = document.querySelectorAll('.quicklink');
    
    quicklinks.forEach(link => {
      link.addEventListener('mouseenter', function() {
        this.style.transition = 'transform 0.3s ease, box-shadow 0.3s ease';
      });
    });

    console.log('HotelLink animations initialized successfully');
  }

})();