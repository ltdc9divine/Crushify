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

  async function loadCatalogPricing() {
    const status = document.getElementById('pricingAvailability');
    const expectedIds = ['our-universe', 'love-letter', 'our-memories', 'say-yes', 'distance-means-nothing'];
    const markUnavailable = () => {
      document.querySelectorAll('[data-template-price]').forEach(node => {
        node.textContent = 'Giá hiện chưa khả dụng';
      });
      document.getElementById('startingPrice').textContent = 'Giá chưa khả dụng';
      document.getElementById('startingPriceNote').textContent = 'Không tạo đơn khi chưa có giá';
      document.getElementById('includedHostingPrice').textContent = 'Chưa có thông tin thời hạn hosting.';
      document.getElementById('additionalHostingPrice').textContent = 'Chưa có thông tin giá hosting.';
      document.getElementById('lifetimePrice').textContent = 'Chưa có thông tin gói trọn đời.';
      document.getElementById('pricingFormula').textContent =
        'Không thể xác nhận giá hiện tại. Vui lòng tải lại trang trước khi tiếp tục.';
      status.textContent = 'Không tải được danh mục giá hiện tại. Chưa thể xác nhận giá hoặc tạo đơn.';
      status.dataset.state = 'error';
    };

    try {
      const response = await fetch('/api/v1/catalog', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error('Catalog request failed');
      const catalog = await response.json();
      const policy = catalog?.pricing_policy;
      const products = expectedIds.map(id => catalog?.products?.find(product => product.id === id));
      const validAmount = amount => Number.isSafeInteger(amount) && amount >= 0;
      if (catalog?.currency !== 'VND' || policy?.currency !== 'VND' ||
          policy.catalog_enabled !== true || typeof catalog.checkout_enabled !== 'boolean' ||
          !Number.isSafeInteger(policy.included_hosting_months) || policy.included_hosting_months < 1 ||
          !validAmount(policy.additional_month_price_minor) ||
          !Number.isSafeInteger(policy.lifetime_price_minor) || policy.lifetime_price_minor < 1 ||
          products.some(product => !product || typeof product.available !== 'boolean' ||
            (product.available && (product.currency !== 'VND' ||
              !Number.isSafeInteger(product.base_price_minor) || product.base_price_minor < 1)))) {
        throw new Error('Catalog response is incomplete');
      }

      const formatVnd = amount => `${new Intl.NumberFormat('vi-VN').format(amount)} đ`;
      const includedMonths = policy.included_hosting_months;
      const availableProducts = products.filter(product => product.available);
      if (!availableProducts.length) throw new Error('No available products');
      const lowestPrice = Math.min(...availableProducts.map(product => product.base_price_minor));

      document.querySelectorAll('[data-template-price]').forEach(node => {
        const product = products.find(item => item.id === node.dataset.templatePrice);
        node.textContent = product?.available
          ? `${formatVnd(product.base_price_minor)} · gồm ${includedMonths} tháng hosting`
          : 'Hiện chưa mở bán';
      });
      document.getElementById('startingPrice').textContent = formatVnd(lowestPrice);
      document.getElementById('startingPriceNote').textContent =
        `từ · đã gồm ${includedMonths} tháng hosting`;
      document.getElementById('includedHostingPrice').textContent =
        `Đã gồm ${includedMonths} tháng hosting trong giá mẫu`;
      document.getElementById('additionalHostingPrice').textContent =
        `Mỗi tháng hosting thêm: ${formatVnd(policy.additional_month_price_minor)}`;
      document.getElementById('lifetimePrice').textContent =
        `Gói trọn đời: ${formatVnd(policy.lifetime_price_minor)}`;
      document.getElementById('pricingFormula').textContent =
        `Tổng theo tháng = giá mẫu + max(0, số tháng − ${includedMonths}) × ` +
        `${formatVnd(policy.additional_month_price_minor)}. Không có tự động gia hạn.`;
      status.textContent = catalog.checkout_enabled
        ? 'Giá đã tải từ catalog. Test mode chỉ dùng trên Preview đã được cấu hình; Production chưa bật.'
        : 'Giá đã tải từ catalog. Tạo đơn hiện chưa mở ở môi trường này; Production chưa bật.';
      status.dataset.state = catalog.checkout_enabled ? 'info' : 'locked';
    } catch (error) {
      markUnavailable();
      console.error('Không thể tải danh mục giá Crushify.', error);
    }
  }
  void loadCatalogPricing();

  const templates = {
    universe: { title: 'Vũ trụ của chúng mình', description: 'Một vũ trụ nhỏ chỉ có hai người. Gửi lời thương qua những vì sao và một trái tim đang phát sáng.', symbol: '♥', theme: 'universe', href: 'templates/our-universe/index.html', guestHref: 'templates/our-universe/index.html?guest=1' },
    letter: { title: 'Lá thư tình', description: 'Một chiếc phong thư mở ra những lời bạn vẫn muốn nói. Nhẹ nhàng, riêng tư và thật nhiều cảm xúc.', symbol: '✉', theme: 'letter', href: 'templates/love-letter/index.html', guestHref: 'templates/love-letter/index.html?guest=1' },
    memories: { title: 'Kỷ niệm đôi mình', description: 'Lưu những bức ảnh, ngày đặc biệt và khoảnh khắc nhỏ thành một cuốn album của hai người.', symbol: '♡', theme: 'memories', href: 'templates/our-memories/index.html', guestHref: 'templates/our-memories/index.html?guest=1' },
    sayyes: { title: 'Hãy nói đồng ý!', description: 'Một lời hỏi dễ thương với những lựa chọn tương tác, dành cho một bất ngờ không thể đoán trước.', symbol: '♥', theme: 'sayyes', href: 'templates/say-yes/index.html', guestHref: 'templates/say-yes/index.html?guest=1' },
    distance: { title: 'Xa mặt không cách lòng', description: 'Một món quà dành cho những trái tim ở xa nhưng vẫn hướng về cùng một nơi.', symbol: '☾', theme: 'distance', href: 'templates/distance-means-nothing/index.html', guestHref: 'templates/distance-means-nothing/index.html?guest=1' }
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
    const [templateKey, item] = Object.entries(templates).find(([, template]) => template.href === card.dataset.href) ?? [];
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
