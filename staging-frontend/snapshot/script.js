function toggleMenu() {
  const m = document.getElementById('menu');
  m.classList.toggle('open');
}
const ano = document.getElementById('ano');
if (ano) ano.textContent = new Date().getFullYear();

document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href');
    const el = document.querySelector(id);
    if (el) {
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});
