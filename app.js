// Navbar transparency on scroll
window.addEventListener('DOMContentLoaded', function() {
  const navbar = document.querySelector('.navbar');
  function updateNavbarTransparency() {
    if (window.scrollY === 0) {
      navbar.classList.add('transparent');
    } else {
      navbar.classList.remove('transparent');
    }
  }
  updateNavbarTransparency();
  window.addEventListener('scroll', updateNavbarTransparency);

  // Typewriter effect
  const phrases = [
    'matematica, dar sigur o vei înțelege.',
    'româna, dar sigur vei trece examenul cu bine.',
    'engleza, dar cu siguranță vei lua examenul Cambridge.'
  ];
  const typewriter = document.getElementById('typewriter');
  let phraseIndex = 0;
  let charIndex = 0;
  let isDeleting = false;

  function type() {
    const currentPhrase = phrases[phraseIndex];
    if (!isDeleting) {
      typewriter.textContent = currentPhrase.substring(0, charIndex + 1);
      charIndex++;
      if (charIndex === currentPhrase.length) {
        isDeleting = true;
        setTimeout(type, 1800); // Pause before deleting
        return;
      }
    } else {
      typewriter.textContent = currentPhrase.substring(0, charIndex - 1);
      charIndex--;
      if (charIndex === 0) {
        isDeleting = false;
        phraseIndex = (phraseIndex + 1) % phrases.length;
        setTimeout(type, 600); // Pause before typing next
        return;
      }
    }
    setTimeout(type, isDeleting ? 30 : 60);
  }
  if (typewriter) type();

  // Scroll-triggered animations for story section
  const storyContent = document.querySelector('.story__content');
  const storyImage = document.querySelector('.story__image');
  
  // Reset initial state
  if (storyContent) {
    storyContent.style.opacity = '0';
    storyContent.style.transform = 'translateX(-50px)';
  }
  if (storyImage) {
    storyImage.style.opacity = '0';
    storyImage.style.transform = 'translateX(50px)';
  }

  function animateOnScroll() {
    const storySection = document.querySelector('.story');
    if (!storySection) return;

    const rect = storySection.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    
    // Trigger animation when section is 20% visible
    if (rect.top < windowHeight * 0.8 && rect.bottom > 0) {
      if (storyContent) {
        storyContent.style.transition = 'opacity 1s ease-out, transform 1s ease-out';
        storyContent.style.opacity = '1';
        storyContent.style.transform = 'translateX(0)';
      }
      
      // Delay image animation
      setTimeout(() => {
        if (storyImage) {
          storyImage.style.transition = 'opacity 1s ease-out, transform 1s ease-out';
          storyImage.style.opacity = '1';
          storyImage.style.transform = 'translateX(0)';
        }
      }, 300);
    }
  }

  // Listen for scroll events
  window.addEventListener('scroll', animateOnScroll);
  
  // Trigger on initial load if section is already visible
  animateOnScroll();

  // Hamburger menu toggle
  const hamburger = document.getElementById('navbarHamburger');
  const menu = document.querySelector('.navbar__menu');
  if (hamburger && menu) {
    hamburger.addEventListener('click', function() {
      const isOpen = menu.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  // Hero button scroll to contact
  const heroButton = document.querySelector('.hero__button');
  if (heroButton) {
    heroButton.addEventListener('click', function() {
      const contactSection = document.getElementById('contact');
      if (contactSection) {
        contactSection.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }
});
