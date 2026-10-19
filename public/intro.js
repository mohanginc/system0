(() => {
  const intro = document.getElementById('brand-intro');
  if (!intro || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (getComputedStyle(intro).position !== 'fixed') return;

  // 한국 날짜를 저장해 새로고침과 재실행에도 하루 한 번만 표시합니다.
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const storageKey = 'system0.intro.lastShownDate';
  try {
    if (localStorage.getItem(storageKey) === today) { intro.remove(); return; }
    localStorage.setItem(storageKey, today);
  } catch {
    // 저장소를 사용할 수 없으면 업무를 방해하지 않도록 인트로를 건너뜁니다.
    intro.remove(); return;
  }

  const pageElements = [...document.querySelectorAll('body > header, body > main, body > footer')]
    .map(element => [element, element.inert]);
  let finished = false;
  // 애니메이션이나 이미지 로드가 실패해도 업무 화면을 계속 가리지 않습니다.
  const fallback = setTimeout(finish, 9000);
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(fallback);
    document.removeEventListener('keydown', skip);
    document.body.classList.remove('intro-playing');
    for (const [element, wasInert] of pageElements) element.inert = wasInert;
    intro.remove();
  }
  function skip(event) {
    if (event.key === 'Escape') finish();
  }

  // 교차점에서 다음 획까지 먼저 칠해지지 않도록 원본의 각 획 안으로 색칠을 제한합니다.
  const strokes = [
    ['1311,-20 1355,-20 1355,559 1311,559', 'M1332 559 L1332 -20', '2.1s', '.9s'],
    ['1299,0 1355,0 1135.55,330 1079.55,330', 'M1340 -20 L1108 330', '3s', '.47s'],
    ['1100,273 1440,130.2 1440,181.2 1100,324', 'M1100 299 L1460 147', '3.47s', '.47s'],
    ['1100,117 1440,130.6 1440,177.6 1100,164', 'M1460 155 L1080 140', '3.94s', '.47s'],
    ['1100,110 1440,382 1440,442 1100,170', 'M1080 124 L1380 364', '4.41s', '.44s'],
  ];
  intro.innerHTML = `<svg class="intro-logo" viewBox="0 0 1722 559" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <mask id="intro-logo-alpha" x="0" y="0" width="1722" height="559" maskUnits="userSpaceOnUse" style="mask-type: alpha">
        <image href="/assets/babestellar-logo.png" width="1722" height="559"/>
      </mask>
      <clipPath id="intro-star-area">
        <rect x="1101" y="0" width="339" height="331"/>
        <rect x="1304" y="331" width="51" height="228"/>
      </clipPath>
      ${strokes.map(([points], index) => `<clipPath id="intro-stroke-${index}"><polygon points="${points}"/></clipPath>`).join('')}
    </defs>
    <g mask="url(#intro-logo-alpha)">
      <rect width="1722" height="559" fill="white"/>
      <g clip-path="url(#intro-star-area)">
        ${strokes.map(([, path, delay, duration], index) => `<path class="intro-star-trace" d="${path}"
          clip-path="url(#intro-stroke-${index})" style="--trace-delay: ${delay}; --trace-duration: ${duration}"
          pathLength="100" fill="none" stroke="#E84D85" stroke-width="100"/>`).join('')}
      </g>
    </g>
  </svg>`;
  intro.addEventListener('animationend', event => {
    if (event.target === intro && event.animationName === 'intro-exit') finish();
  });
  document.addEventListener('keydown', skip);
  for (const [element] of pageElements) element.inert = true;
  document.body.classList.add('intro-playing');
  intro.hidden = false;

  const logo = new Image();
  logo.onload = () => { if (!finished) intro.classList.add('is-playing'); };
  logo.onerror = finish;
  logo.src = '/assets/babestellar-logo.png';
})();
