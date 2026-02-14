import { client, geocode, plan, type Itinerary } from '@motis-project/motis-client'
import type { Place } from './config'

client.setConfig({
  baseUrl: 'https://api.transitous.org',
})

export async function searchStation(query: string): Promise<Place[]> {
  if (!query || query.length < 3) return []

  try {
    const { data, error } = await geocode({ query: { text: query, type: 'STOP' } })
    if (error || !data) {
      console.error('[transit] station search failed', error)
      return []
    }

    return (data as Array<{ name: string; id: string }>).map((match) => ({
      name: match.name,
      id: match.id,
    }))
  } catch (error) {
    console.error('[transit] station search exception', error)
    return []
  }
}

export async function fetchConnections(from: Place, to: Place): Promise<Itinerary[]> {
  try {
    const { data, error } = await plan({
      query: {
        fromPlace: from.id,
        toPlace: to.id,
        joinInterlinedLegs: false,
        maxMatchingDistance: 250,
        fastestDirectFactor: 1.5,
        detailedTransfers: false,
        time: new Date().toISOString(),
      },
    })

    if (error || !data) {
      console.error('[transit] plan query failed', error)
      return []
    }

    return data.itineraries || []
  } catch (error) {
    console.error('[transit] plan query exception', error)
    return []
  }
}
