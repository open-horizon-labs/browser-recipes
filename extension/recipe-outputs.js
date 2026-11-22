export function renderRecipeOutputs(outputs, output, downloadUrls) {
  for (const [name, value] of Object.entries(outputs)) {
    const heading = document.createElement('h3');
    heading.textContent = name;
    output.append(heading);
    if (value?.kind === 'file') {
      const bytes = Uint8Array.from(atob(value.base64), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
      downloadUrls.push(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = value.name;
      link.textContent = `Download ${value.name}`;
      output.append(link);
    } else {
      const text = document.createElement('pre');
      text.textContent = value?.kind === 'markdown'
        ? value.markdown
        : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      output.append(text);
    }
  }
}
