import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { officialCalendarUrl, readCalendarDays } from './market-calendar.js';

const server = new Server(
  { name: 'workplot-calendar', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
const tool = 'read_market_calendar';
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: tool,
      description:
        'Read the official Tsukiji market calendar for one month. Individual shops may differ.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          month: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
        },
        required: ['month'],
        additionalProperties: false,
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments;
  if (
    req.params.name !== tool ||
    typeof args?.month !== 'string' ||
    Object.keys(args).length !== 1
  )
    throw Error('잘못된 달력 요청');
  try {
    const url = officialCalendarUrl(args.month);
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw Error('공식 달력 응답 오류 ' + res.status);
    const days = readCalendarDays(await res.text(), args.month);
    return {
      content: [
        {
          type: 'text',
          text: [
            url,
            new Date().toISOString(),
            '도쿄 중앙도매시장 달력. 장외시장 개별 점포는 다를 수 있습니다.',
            days,
          ].join('\n'),
        },
      ],
    };
  } catch {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: '운영일 미확인: 공식 달력을 읽거나 검증할 수 없습니다.',
        },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
