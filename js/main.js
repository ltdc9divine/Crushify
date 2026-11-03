(() => {
  const menuToggle = document.getElementById('menuToggle');
  const mainNav = document.getElementById('mainNav');
  menuToggle?.addEventListener('click', () => {
    const open = menuToggle.getAttribute('aria-expanded') !== 'true';
    menuToggle.setAttribute('aria-expanded', String(open));
    mainNav?.classList.toggle('open', open);
  });
  mainNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
    mainNav.classList.remove('open'); menuToggle?.setAttribute('aria-expanded', 'false');
  }));

  const chips = [...document.querySelectorAll('.filter-chip')];
  const cards = [...document.querySelectorAll('.template-card')];
  cards.filter(card => card.dataset.href).forEach(card => card.addEventListener('click', event => {
    if (event.target.closest('a, button')) return;
    window.location.assign(card.dataset.href);
  }));
  chips.forEach(chip => chip.addEventListener('click', () => {
    chips.forEach(item => item.classList.toggle('active', item === chip));
    const filter = chip.dataset.filter;
    cards.forEach(card => card.classList.toggle('is-hidden', filter !== 'all' && card.dataset.category !== filter));
  }));

  const templates = {
    universe: { title: 'Our Universe', description: 'Một vũ trụ nhỏ chỉ có hai người. Gửi lời thương qua những vì sao và một trái tim đang phát sáng.', symbol: '♥', theme: 'universe', href: 'templates/our-universe/index.html' },
    letter: { title: 'Love Letter', description: 'Một chiếc phong thư mở ra những lời bạn vẫn muốn nói. Nhẹ nhàng, riêng tư và thật nhiều cảm xúc.', symbol: '✉', theme: 'letter', href: 'templates/love-letter/index.html' },
    memories: { title: 'Our Memories', description: 'Lưu những bức ảnh, ngày đặc biệt và khoảnh khắc nhỏ thành một cuốn album của hai người.', symbol: '♡', theme: 'memories', href: 'templates/our-memories/index.html' },
    sayyes: { title: 'Say Yes!', description: 'Một lời hỏi dễ thương với những lựa chọn tương tác, dành cho một bất ngờ không thể đoán trước.', symbol: '♥', theme: 'sayyes', href: 'templates/say-yes/index.html' },
    distance: { title: 'Distance Means Nothing', description: 'Một món quà dành cho những trái tim ở xa nhưng vẫn hướng về cùng một nơi.', symbol: '☾', theme: 'distance' }
  };
  const modal = document.getElementById('previewModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalDescription = document.getElementById('modalDescription');
  const modalVisual = document.getElementById('modalVisual');
  const modalChoose = document.getElementById('modalChoose');
  let lastFocus = null;
  function closeModal() {
    modal?.classList.remove('open'); modal?.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    lastFocus?.focus();
  }
  document.querySelectorAll('.preview-btn').forEach(button => button.addEventListener('click', () => {
    const item = templates[button.dataset.template];
    if (!item || !modal) return;
    lastFocus = button;
    modalTitle.textContent = item.title;
    modalDescription.textContent = item.description;
    modalVisual.dataset.theme = item.theme;
    modalVisual.innerHTML = `<span class="modal-symbol" aria-hidden="true">${item.symbol}</span>`;
    modalChoose.href = item.href || '#pricing';
    modalChoose.firstChild.textContent = item.href ? 'Mở template ' : 'Chọn mẫu này ';
    modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    modal.querySelector('.modal-close')?.focus();
  }));
  modal?.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal?.classList.contains('open')) closeModal();
  });
  modalChoose?.addEventListener('click', closeModal);
})();
