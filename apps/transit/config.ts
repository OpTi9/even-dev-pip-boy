export interface Place {
  name: string
  id: string
}

export interface SavedConnection {
  id: string
  from: Place
  to: Place
}

export const STORAGE_KEY = 'even_transport_connections'

export const PLACES: Record<string, Place> = {
  Frankfurt: { name: 'Frankfurt (Main) Hbf', id: 'nl-ovapi_stoparea:17791' },
  Destination: { name: 'Destination', id: 'de-DELFI_de:08222:2417' },
}

export const DEFAULT_CONNECTIONS: SavedConnection[] = [
  {
    id: 'default-frankfurt-destination',
    from: PLACES.Frankfurt,
    to: PLACES.Destination,
  },
]
