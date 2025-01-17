import 'reflect-metadata'

import { Timer } from './Timer'

describe('Timer', () => {
  const createTimer = () => new Timer()

  it('should return a timestamp in microseconds', () => {
    const timestamp = createTimer().getTimestampInMicroseconds()
    expect(`${timestamp}`.length).toEqual(16)
  })

  it('should return a utc date', () => {
    const date = createTimer().getUTCDate()
    expect(date).toBeInstanceOf(Date)
  })

  it('should return a utc date n days ago', () => {
    const date = createTimer().getUTCDate()
    const dateNDaysAgo = createTimer().getUTCDateNDaysAgo(4)

    expect(+date - +dateNDaysAgo >= 4 * 24 * 3600).toBeTruthy()
  })

  it('should return a utc date n days ahead', () => {
    const date = createTimer().getUTCDate()
    const dateNDaysAhead = createTimer().getUTCDateNDaysAhead(4)

    expect(+dateNDaysAhead - +date >= 4 * 24 * 3600).toBeTruthy()
  })

  it('should return a utc date n hours ago', () => {
    const date = createTimer().getUTCDate()
    const dateNHoursAgo = createTimer().getUTCDateNHoursAgo(4)

    expect(+date - +dateNHoursAgo >= 4 * 3600).toBeTruthy()
  })

  it('should return a utc date n hours ahead', () => {
    const date = createTimer().getUTCDate()
    const dateNHoursAhead = createTimer().getUTCDateNHoursAhead(4)

    expect(+dateNHoursAhead - +date >= 4 * 3600).toBeTruthy()
  })

  it('should convert a string date to microseconds', () => {
    const timestamp = createTimer().convertStringDateToMicroseconds('2021-03-29 08:00:05.233Z')
    expect(timestamp).toEqual(1617004805233000)
  })

  it('should convert microseconds to string date', () => {
    expect(createTimer().convertMicrosecondsToStringDate(1617004805233123))
      .toEqual('2021-03-29T08:00:05.233123Z')
  })

  it('should convert a string date to milliseconds', () => {
    const timestamp = createTimer().convertStringDateToMilliseconds('Mon Mar 29 2021 12:13:45 GMT+0200')
    expect(timestamp).toEqual(1617012825000)
  })

  it('should convert a string date to date', () => {
    const date = createTimer().convertStringDateToDate('Mon Mar 29 2021 12:13:45 GMT+0200')
    expect(date).toEqual(new Date(1617012825000))
  })

  it('should convert microseconds to date', () => {
    expect(createTimer().convertMicrosecondsToDate(1617004805233123)).toEqual(new Date('2021-03-29T08:00:05.233123Z'))
  })

  it('should convert microseconds to milliseconds', () => {
    expect(createTimer().convertMicrosecondsToMilliseconds(1616164633241312)).toEqual(1616164633241)
  })

  it('should convert microseconds to seconds', () => {
    expect(createTimer().convertMicrosecondsToSeconds(1616164633241312)).toEqual(1616164633)
  })
})
