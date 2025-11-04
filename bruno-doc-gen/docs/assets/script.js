// Main functionality
document.addEventListener('DOMContentLoaded', function() {
  // Sidebar toggle
  const toggleSidebar = document.getElementById('toggle-sidebar');
  const sidebar = document.getElementById('sidebar');

  if (toggleSidebar && sidebar) {
    toggleSidebar.addEventListener('click', function(e) {
      e.preventDefault();
      sidebar.classList.toggle('active');
    });
  }

  // Language tab switching
  document.querySelectorAll('.lang-tab').forEach(tab => {
    tab.addEventListener('click', function() {
      const lang = this.getAttribute('data-lang');
      const parent = this.closest('.examples');

      // Update active tab
      parent.querySelectorAll('.lang-tab').forEach(t => t.classList.remove('active'));
      this.classList.add('active');

      // Update active code sample
      parent.querySelectorAll('.code-sample').forEach(sample => {
        sample.classList.remove('active');
        if (sample.getAttribute('data-lang') === lang) {
          sample.classList.add('active');
        }
      });
    });
  });

  // Smooth scrolling for navigation links
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      const targetId = this.getAttribute('href').substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
});

