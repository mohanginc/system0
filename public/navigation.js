(() => {
  const pages = [
    ['/', '주문 수집'],
    ['/product-names', '상품명 정리'],
    ['/invoices.html', '송장 처리'],
    ['/shipping-board.html', '출고 보드'],
    ['/products.html', '상품·바코드'],
    ['/llm-usage.html', 'AI 호출 내역'],
  ];
  const { pathname, search } = window.location;
  const productReview = pathname === '/index.html' || (pathname === '/' && new URLSearchParams(search).has('batch'));
  const orderIntake = ['/order-intake.html', '/order-packing.html'].includes(pathname);
  const current = productReview ? '/product-names' : orderIntake ? '/' : pathname;
  for (const nav of document.querySelectorAll('.app-nav')) {
    nav.replaceChildren(...pages.map(([href, title]) => {
      const link = document.createElement('a');
      link.href = href; link.textContent = title;
      if (href === current) link.setAttribute('aria-current', 'page');
      return link;
    }));
  }
})();
