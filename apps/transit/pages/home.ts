import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { SavedConnection } from '../config'

export async function renderHome(bridge: EvenAppBridge, isFirstRender: boolean, connections: SavedConnection[]) {
  const textContainer = new TextContainerProperty({
    containerID: 1,
    containerName: 'title-txt',
    content: 'Even Transit',
    xPosition: 8,
    yPosition: 0,
    width: 240,
    height: 32,
    isEventCapture: 0,
  })

  const connectionNames =
    connections.length > 0
      ? connections.map((connection) => `${connection.from.name.substring(0, 30)} -> ${connection.to.name.substring(0, 30)}`)
      : ['No saved connections']

  const listContainer = new ListContainerProperty({
    containerID: 2,
    containerName: 'home-list',
    itemContainer: new ListItemContainerProperty({
      itemCount: connectionNames.length,
      itemWidth: 566,
      isItemSelectBorderEn: 1,
      itemName: connectionNames,
    }),
    isEventCapture: 1,
    xPosition: 4,
    yPosition: 40,
    width: 572,
    height: 248,
  })

  const config = {
    containerTotalNum: 2,
    textObject: [textContainer],
    listObject: [listContainer],
  }

  if (isFirstRender) {
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config))
    return
  }

  await bridge.rebuildPageContainer(new RebuildPageContainer(config))
}
