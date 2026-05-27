import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  projectId: string;
}

export default function OutlineView({ projectId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'outline'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files/.novel/outline-detailed.md`);
      if (!res.ok) return null;
      return res.text();
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>尚未创建大纲。在聊天面板中输入 /outline 开始。</div>;

  return (
    <div>
      <h3>大纲</h3>
      <Markdown remarkPlugins={[remarkGfm]}>{data}</Markdown>
    </div>
  );
}
