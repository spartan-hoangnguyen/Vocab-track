const $ = (id) => document.getElementById(id);

function showView(name) {
  $('view-lookup').hidden = name !== 'lookup';
  $('view-review').hidden = name !== 'review';
  $('tab-lookup').classList.toggle('active', name === 'lookup');
  $('tab-review').classList.toggle('active', name === 'review');
}

$('tab-lookup').addEventListener('click', () => showView('lookup'));
$('tab-review').addEventListener('click', () => showView('review'));
