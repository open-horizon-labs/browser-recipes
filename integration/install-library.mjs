export async function chooseDefinitions(page, value) {
  await page.locator('#catalog-file').setInputFiles({
    name:'definitions.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(value)),
  });
}
export async function installDefinitions(page, value) {
  await chooseDefinitions(page,value);
  await page.getByRole('button',{name:'Install changes'}).click();
  await page.getByText('Changes installed.',{exact:true}).waitFor();
}
