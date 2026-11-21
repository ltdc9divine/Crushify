(() => {
  const menuToggle = document.getElementById('menuToggle');
  const mainNav = document.getElementById('mainNav');
  const setMenuOpen = open => {
    menuToggle?.setAttribute('aria-expanded', String(open));
    menuToggle?.setAttribute('aria-label', open ? 'Đóng menu' : 'Mở menu');
    mainNav?.classList.toggle('open', open);
  };
  menuToggle?.addEventListener('click', () => {
    const open = menuToggle.getAttribute('aria-expanded') !== 'true';
    setMenuOpen(open);
  });
  mainNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
    setMenuOpen(false);
  }));

  const chips = [...document.querySelectorAll('.filter-chip')];
  const cards = [...document.querySelectorAll('.template-card')];
  cards.filter(card => card.dataset.href).forEach(card => card.addEventListener('click', event => {
    if (event.target.closest('a, button')) return;
    window.location.assign(card.dataset.href);
  }));
  chips.forEach(chip => chip.addEventListener('click', () => {
    chips.forEach(item => {
      const active = item === chip;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    const filter = chip.dataset.filter;
    cards.forEach(card => card.classList.toggle('is-hidden', filter !== 'all' && card.dataset.category !== filter));
  }));

  void window.loadCrushifyCatalogPricing();

  const templates = {
    universe: { title: 'Vũ trụ của chúng mình', description: 'Một vũ trụ nhỏ chỉ có hai người. Gửi lời thương qua những vì sao và một trái tim đang phát sáng.', symbol: '♥', theme: 'universe', guestHref: 'templates/our-universe/index.html?guest=1' },
    letter: { title: 'Lá thư tình', description: 'Một chiếc phong thư mở ra những lời bạn vẫn muốn nói. Nhẹ nhàng, riêng tư và thật nhiều cảm xúc.', symbol: '✉', theme: 'letter', guestHref: 'templates/love-letter/index.html?guest=1' },
    memories: { title: 'Kỷ niệm đôi mình', description: 'Lưu những bức ảnh, ngày đặc biệt và khoảnh khắc nhỏ thành một cuốn album của hai người.', symbol: '♡', theme: 'memories', guestHref: 'templates/our-memories/index.html?guest=1' },
    sayyes: { title: 'Hãy nói đồng ý!', description: 'Một lời hỏi dễ thương với những lựa chọn tương tác, dành cho một bất ngờ không thể đoán trước.', symbol: '♥', theme: 'sayyes', guestHref: 'templates/say-yes/index.html?guest=1' },
    distance: { title: 'Xa mặt không cách lòng', description: 'Một món quà dành cho những trái tim ở xa nhưng vẫn hướng về cùng một nơi.', symbol: '☾', theme: 'distance', guestHref: 'templates/distance-means-nothing/index.html?guest=1' }
  };
  const modal = document.getElementById('previewModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalDescription = document.getElementById('modalDescription');
  const modalVisual = document.getElementById('modalVisual');
  const modalChoose = document.getElementById('modalChoose');
  function closeModal() {
    if (modal?.open) modal.close();
  }
  cards.forEach(card => {
    const [templateKey, item] = Object.entries(templates).find(([, template]) => template.guestHref === card.dataset.href) ?? [];
    const details = card.querySelector('.template-info > div');
    if (!templateKey || !item || !details) return;

    const button = document.createElement('button');
    button.className = 'preview-btn template-preview';
    button.type = 'button';
    button.dataset.template = templateKey;
    button.setAttribute('aria-label', `Xem trước ${item.title}`);
    button.textContent = 'Xem trước';
    details.append(button);

    const guestLink = document.createElement('a');
    guestLink.className = 'template-order-link template-guest-link';
    guestLink.href = item.guestHref;
    guestLink.append('Thử mẫu ');
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    guestLink.append(arrow);
    details.append(guestLink);
  });
  document.querySelectorAll('.preview-btn').forEach(button => button.addEventListener('click', () => {
    const item = templates[button.dataset.template];
    if (!item || !modal) return;
    modalTitle.textContent = item.title;
    modalDescription.textContent = item.description;
    modalVisual.dataset.theme = item.theme;
    const symbol = document.createElement('span');
    symbol.className = 'modal-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = item.symbol;
    modalVisual.replaceChildren(symbol);
    modalChoose.href = item.guestHref;
    modalChoose.firstChild.textContent = 'Thử mẫu ';
    if (!modal.open) modal.showModal();
  }));
  modal?.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
  modal?.addEventListener('click', event => {
    if (event.target === modal) closeModal();
  });
})();
