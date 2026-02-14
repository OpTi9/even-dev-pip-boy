import { EvenBetterSdk } from '@jappyjan/even-better-sdk';

const sdk = new EvenBetterSdk();

const page = sdk.createPage('example-page');
page
  .addTextElement('Hello from Even Better SDK')
  .setPosition(position => position.setX(12).setY(20))
  .setSize(size => size.setWidth(240).setHeight(60));

await page.render();

