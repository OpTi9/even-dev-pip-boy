import type { Itinerary } from '@motis-project/motis-client'

export function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  })
}

export function extractItinerarySummaries(itineraries: Itinerary[]): string[] {
  return itineraries.map((itinerary) => {
    const start = formatTime(itinerary.startTime)
    const end = formatTime(itinerary.endTime)

    const realTime = new Date(itinerary.startTime).getTime()
    const firstLeg = itinerary.legs[0]
    const schedTimeStr = firstLeg?.scheduledStartTime || itinerary.startTime
    const schedTime = new Date(schedTimeStr).getTime()
    const delayMins = Math.round((realTime - schedTime) / 60000)
    const delayStr = delayMins > 0 ? `(+${delayMins})` : ''

    const duration = `${Math.round(itinerary.duration / 60)}min`
    const mainLeg = itinerary.legs.find((leg) => leg.mode !== 'WALK') || itinerary.legs[0]
    const trainName = mainLeg.displayName || mainLeg.tripShortName || 'N/A'
    const track = mainLeg.from.track || mainLeg.from.scheduledTrack || '?'
    const transferStr = itinerary.transfers === 0 ? 'Dir' : `${itinerary.transfers}x`

    return `${start}${delayStr} - ${end} | ${duration} | ${transferStr} | ${trainName} | Pl. ${track}`
  })
}
