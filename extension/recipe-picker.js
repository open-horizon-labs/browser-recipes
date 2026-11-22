export function createRecipePicker(root, onSelect) {
  const input = root.querySelector('input');
  const browse = root.querySelector('button');
  const list = root.querySelector('[role=listbox]');
  const empty = root.querySelector('[role=status]');
  let options = [];
  let matches = [];
  let selected;
  let active = -1;
  let expanded = false;
  let query = '';

  function setActive(index) {
    list.children[active]?.removeAttribute('data-active');
    active = index;
    const row = list.children[active];
    if (row) {
      row.dataset.active = '';
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({block:'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    expanded = false;
    query = '';
    input.value = selected?.title ?? '';
    input.setAttribute('aria-expanded','false');
    browse.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');
    list.hidden = empty.hidden = true;
    active = -1;
  }

  function show() {
    expanded = true;
    const terms = query.toLowerCase().trim().split(/\s+/);
    matches = options.filter(recipe => {
      const name = (recipe.title + ' ' + recipe.app + ' ' + recipe.key).toLowerCase();
      return terms.every(term => name.includes(term));
    });
    list.replaceChildren();
    for (const [index, recipe] of matches.entries()) {
      const row = document.createElement('li');
      row.id = list.id + '-' + index;
      row.setAttribute('role','option');
      row.setAttribute('aria-selected',String(recipe.key === selected?.key));
      const app = document.createElement('small');
      app.textContent = recipe.app;
      row.append(document.createTextNode(recipe.title),app);
      row.addEventListener('pointerdown',event => event.preventDefault());
      row.addEventListener('click',() => select(recipe));
      list.append(row);
    }
    list.hidden = false;
    empty.hidden = matches.length !== 0;
    input.setAttribute('aria-expanded','true');
    browse.setAttribute('aria-expanded','true');
    active = -1;
    input.removeAttribute('aria-activedescendant');
  }

  function select(recipe) {
    selected = recipe;
    close();
    onSelect();
  }

  input.addEventListener('focus',() => input.select());
  input.addEventListener('click',() => { if (!expanded) show(); });
  input.addEventListener('input',() => { query = input.value; show(); });
  browse.addEventListener('click',() => {
    if (expanded) close();
    else {
      query = '';
      input.focus();
      show();
    }
  });
  root.addEventListener('focusout',event => {
    if (!root.contains(event.relatedTarget)) close();
  });
  root.addEventListener('keydown',event => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) show();
      if (!matches.length) return;
      const next = event.key === 'ArrowDown' ? active + 1 : active < 0 ? matches.length - 1 : active - 1;
      setActive(Math.max(0,Math.min(matches.length - 1,next)));
    } else if (event.key === 'Enter' && expanded && event.target === input) {
      event.preventDefault();
      if (matches[active] ?? matches[0]) select(matches[active] ?? matches[0]);
    }
  });

  return {
    get value() { return selected?.key ?? ''; },
    update(recipes, key) {
      const previous = selected?.key;
      options = recipes;
      selected = recipes.find(recipe => recipe.key === key);
      input.disabled = browse.disabled = !options.length;
      if (expanded && options.length && previous === selected?.key) show();
      else close();
    },
  };
}
