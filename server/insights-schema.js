// Schema của tài liệu "insights" (phần Phân tích & đề xuất). Giữ khớp với tools/insights.schema.json – có kiểm thử so sánh hai bản.
// Để dạng module JS (không import JSON) cho chắc chắn được đóng gói vào hàm Vercel.
export default {
 "type": "object",
 "required": [
  "v",
  "updatedAt",
  "updatedLabel",
  "dataUntil",
  "periodLabel",
  "headline",
  "summary",
  "highlights",
  "evaluations",
  "recommendations",
  "pillars",
  "calendar",
  "budget",
  "tests",
  "audience",
  "targets",
  "method"
 ],
 "properties": {
  "v": {
   "const": 1
  },
  "updatedAt": {
   "type": "string",
   "description": "ISO time of this update"
  },
  "updatedLabel": {
   "type": "string",
   "description": "e.g. 06:35 14/10/2026 (Hà Nội time)"
  },
  "dataUntil": {
   "type": "string",
   "description": "YYYY-MM-DD, TODAY"
  },
  "periodLabel": {
   "type": "string",
   "description": "e.g. 30 ngày qua (14/09–13/10/2026) và năm học 2025–2026"
  },
  "headline": {
   "type": "string",
   "description": "one sentence, <= 110 characters"
  },
  "summary": {
   "type": "string",
   "description": "2-3 sentences with spend, leads, cost per lead of the last 30 days and the year view"
  },
  "highlights": {
   "type": "array",
   "minItems": 4,
   "maxItems": 4,
   "items": {
    "type": "object",
    "required": [
     "tone",
     "title",
     "detail"
    ],
    "properties": {
     "tone": {
      "enum": [
       "good",
       "warn",
       "bad",
       "info"
      ]
     },
     "title": {
      "type": "string"
     },
     "detail": {
      "type": "string"
     }
    }
   }
  },
  "evaluations": {
   "type": "array",
   "minItems": 6,
   "maxItems": 6,
   "description": "areas in order: Hiệu quả chi phí/lead; Nhịp độ & phân bổ ngân sách; Chất lượng nội dung; Nhắm chọn đối tượng; Cấu trúc tài khoản & chiến dịch; Đo lường & theo dõi lead",
   "items": {
    "type": "object",
    "required": [
     "area",
     "verdict",
     "tone",
     "text"
    ],
    "properties": {
     "area": {
      "type": "string"
     },
     "verdict": {
      "type": "string",
      "description": "Tốt / Khá / Cần cải thiện / Cần xử lý ngay"
     },
     "tone": {
      "enum": [
       "good",
       "warn",
       "bad",
       "info"
      ]
     },
     "text": {
      "type": "string"
     }
    }
   }
  },
  "recommendations": {
   "type": "array",
   "minItems": 6,
   "maxItems": 8,
   "items": {
    "type": "object",
    "required": [
     "title",
     "detail",
     "owner",
     "when",
     "impact"
    ],
    "properties": {
     "title": {
      "type": "string"
     },
     "detail": {
      "type": "string"
     },
     "owner": {
      "enum": [
       "Ban Truyền thông",
       "Ban Tuyển sinh",
       "Người chạy quảng cáo",
       "Ban Giám hiệu"
      ]
     },
     "when": {
      "type": "string"
     },
     "impact": {
      "type": "string"
     }
    }
   }
  },
  "pillars": {
   "type": "array",
   "minItems": 5,
   "maxItems": 6,
   "items": {
    "type": "object",
    "required": [
     "name",
     "segment",
     "why",
     "audience",
     "formats",
     "hooks",
     "kpi"
    ],
    "properties": {
     "name": {
      "type": "string"
     },
     "segment": {
      "enum": [
       "l1",
       "l10",
       "l6",
       "js",
       "camp",
       "brand",
       "mix"
      ]
     },
     "why": {
      "type": "string"
     },
     "audience": {
      "type": "string"
     },
     "formats": {
      "type": "array",
      "items": {
       "type": "string"
      }
     },
     "hooks": {
      "type": "array",
      "items": {
       "type": "string"
      }
     },
     "kpi": {
      "type": "string"
     }
    }
   }
  },
  "calendar": {
   "type": "array",
   "minItems": 4,
   "maxItems": 4,
   "items": {
    "type": "object",
    "required": [
     "week",
     "focus",
     "items"
    ],
    "properties": {
     "week": {
      "type": "string"
     },
     "focus": {
      "type": "string"
     },
     "items": {
      "type": "array",
      "minItems": 2,
      "maxItems": 4,
      "items": {
       "type": "object",
       "required": [
        "title",
        "segment",
        "format",
        "objective"
       ],
       "properties": {
        "title": {
         "type": "string"
        },
        "note": {
         "type": "string"
        },
        "segment": {
         "enum": [
          "l1",
          "l10",
          "l6",
          "js",
          "camp",
          "brand",
          "mix"
         ]
        },
        "format": {
         "type": "string"
        },
        "objective": {
         "type": "string"
        }
       }
      }
     }
    }
   }
  },
  "budget": {
   "type": "object",
   "required": [
    "summary",
    "split"
   ],
   "properties": {
    "summary": {
     "type": "string"
    },
    "split": {
     "type": "array",
     "description": "pct values sum to 100",
     "items": {
      "type": "object",
      "required": [
       "segment",
       "label",
       "pct",
       "reason"
      ],
      "properties": {
       "segment": {
        "enum": [
         "l1",
         "l10",
         "l6",
         "js",
         "camp",
         "brand",
         "mix"
        ]
       },
       "label": {
        "type": "string"
       },
       "pct": {
        "type": "number"
       },
       "reason": {
        "type": "string"
       }
      }
     }
    }
   }
  },
  "tests": {
   "type": "array",
   "minItems": 3,
   "maxItems": 4,
   "items": {
    "type": "object",
    "required": [
     "hypothesis",
     "setup",
     "metric"
    ],
    "properties": {
     "hypothesis": {
      "type": "string"
     },
     "setup": {
      "type": "string"
     },
     "metric": {
      "type": "string"
     }
    }
   }
  },
  "audience": {
   "type": "array",
   "minItems": 4,
   "maxItems": 6,
   "items": {
    "type": "string"
   }
  },
  "targets": {
   "type": "array",
   "minItems": 4,
   "maxItems": 6,
   "items": {
    "type": "object",
    "required": [
     "metric",
     "current",
     "target"
    ],
    "properties": {
     "metric": {
      "type": "string"
     },
     "current": {
      "type": "string"
     },
     "target": {
      "type": "string"
     },
     "note": {
      "type": "string"
     }
    }
   }
  },
  "method": {
   "type": "array",
   "minItems": 3,
   "maxItems": 5,
   "items": {
    "type": "string"
   }
  }
 }
};
