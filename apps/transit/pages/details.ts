import {
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { Itinerary } from '@motis-project/motis-client'
import { formatTime } from '../utils'

type PointType = 'from' | 'to'

function getPointInfo(leg: Itinerary['legs'][number], type: PointType) {
  const isFrom = type === 'from'
  const timeProp = isFrom ? 'startTime' : 'endTime'
  const schedTimeProp = isFrom ? 'scheduledStartTime' : 'scheduledEndTime'
  const station = isFrom ? leg.from : leg.to

  const timeVal = leg[timeProp]
  const schedTimeVal = leg[schedTimeProp] || timeVal
  const timeFormatted = formatTime(timeVal)

  const real = new Date(timeVal).getTime()
  const sched = new Date(schedTimeVal).getTime()
  const delay = Math.round((real - sched) / 60000)
  const delayStr = delay > 0 ? `(+${delay})` : ''

  const timeStr = `${timeFormatted}${delayStr}`
  const track = station.track || station.scheduledTrack

  let name = station.name
  if (name.length > 45) {
    name = `${name.substring(0, 42)}...`
  }

  const nameStr = track ? `${name} Pl.${track}` : name
  return { timeStr, nameStr, fullStr: `${timeStr} ${nameStr}` }
}

function extractLegDetails(itinerary: Itinerary): string[] {
  const details: string[] = []
  let skipNextDeparture = false

  for (let index = 0; index < itinerary.legs.length; index += 1) {
    const leg = itinerary.legs[index]

    if (!skipNextDeparture) {
      details.push(getPointInfo(leg, 'from').fullStr)
    }
    skipNextDeparture = false

    const duration = Math.round(leg.duration / 60)
    const mode = leg.mode === 'WALK' ? 'Walk' : leg.displayName || leg.tripShortName || leg.mode
    details.push(`  |   ${mode} (${duration}min)`)

    if (leg.mode === 'WALK' && index < itinerary.legs.length - 1) {
      continue
    }

    const arrival = getPointInfo(leg, 'to')
    if (index < itinerary.legs.length - 1) {
      const nextDeparture = getPointInfo(itinerary.legs[index + 1], 'from')
      if (arrival.nameStr === nextDeparture.nameStr) {
        skipNextDeparture = true
        if (arrival.timeStr === nextDeparture.timeStr) {
          details.push(arrival.fullStr)
        } else {
          details.push(`${arrival.timeStr} - ${nextDeparture.timeStr} ${arrival.nameStr}`)
        }
        continue
      }
    }

    details.push(arrival.fullStr)
  }

  return details
}

export async function renderDetails(bridge: EvenAppBridge, itinerary: Itinerary) {
  const textContainer = new TextContainerProperty({
    containerID: 1,
    containerName: 'title-txt',
    content: 'Trip Details',
    xPosition: 8,
    yPosition: 0,
    width: 240,
    height: 32,
    isEventCapture: 0,
  })

  const listItems = extractLegDetails(itinerary)

  const listContainer = new ListContainerProperty({
    containerID: 2,
    containerName: 'detail-list',
    itemContainer: new ListItemContainerProperty({
      itemCount: listItems.length,
      itemWidth: 566,
      isItemSelectBorderEn: 0,
      itemName: listItems,
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
