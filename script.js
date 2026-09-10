import { animate, inView, stagger } from 'https://cdn.jsdelivr.net/npm/motion@latest/+esm';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const cards = document.querySelectorAll('.card');

if (!prefersReducedMotion) {
  animate(cards, { opacity: 0, y: 24 }, { duration: 0 });

  inView('.cards', () => {
    animate(
      cards,
      { opacity: [0, 1], y: [24, 0] },
      { duration: 0.5, ease: 'easeOut', delay: stagger(0.08) }
    );
  });
}
