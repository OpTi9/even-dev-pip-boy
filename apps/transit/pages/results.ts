import {
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Itinerary } from '@motis-project/motis-client'
import { extractItinerarySummaries } from '../utils'

export async function renderResults(bridge: EvenAppBridge, connections: Itinerary[]) {
  const textContainer = new TextContainerProperty({
    containerID: 1,
    containerName: 'title-txt',
    content: 'Connections',
    xPosition: 8,
    yPosition: 0,
    width: 240,
    height: 32,
    isEventCapture: 0,
  })

  const listItems = extractItinerarySummaries(connections)

  const listContainer = new ListContainerProperty({
    containerID: 2,
    containerName: 'res-list',
    itemContainer: new ListItemContainerProperty({
      itemCount: listItems.length > 0 ? listItems.length : 1,
      itemWidth: 566,
      isItemSelectBorderEn: 1,
      itemName: listItems.length > 0 ? listItems : ['No connections found'],
    }),
    isEventCapture: 1,
    xPosition: 4,
    yPosition: 40,
    width: 572,
    height: 248,
  })

  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 2,
      textObject: [textContainer],
      listObject: [listContainer],
    }),
  )
}
